/**
 * WeChat iLink Bot Connection Factory
 *
 * Implements WeChat messaging via iLink Bot API:
 * - HTTP long-polling for inbound messages (getupdates, 35s timeout)
 * - HTTP POST for outbound messages (sendmessage)
 * - Context token tracking (each reply must echo inbound context_token)
 * - Sync state persistence (get_updates_buf survives restarts)
 * - Message deduplication (LRU 1000 / 30min TTL)
 * - AES-128-ECB media download
 * - Markdown → plain text stripping for outbound
 *
 * Reference: @tencent-weixin/openclaw-weixin protocol
 */
import crypto from 'crypto';
import {
  getUpdates,
  sendTextMessage,
  sendTyping as apiSendTyping,
  getConfig,
  downloadMedia,
  MessageItemType,
  SESSION_EXPIRED_ERRCODE,
  type WechatInboundMessage,
  type WechatMessageItem,
} from './wechat-api.js';
import { storeChatMetadata, storeMessageDirect } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';

// ─── Constants ──────────────────────────────────────────────────

const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const MSG_SPLIT_LIMIT = 4000;
const POLL_BACKOFF_INITIAL_MS = 5_000;
const POLL_BACKOFF_MAX_MS = 60_000;
const POLL_RETRY_IMMEDIATE_MS = 100;

// ─── Types ──────────────────────────────────────────────────────

export interface WechatConnectionConfig {
  botToken: string;
  botName?: string;
  /** Restored sync state (loaded from file) */
  getUpdatesBuf?: string;
}

export interface WechatConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Callback to persist sync state (get_updates_buf). Called after each poll. */
  onSyncStateChanged?: (buf: string) => void;
}

export interface WechatConnection {
  connect(opts: WechatConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert Markdown to plain text.
 * WeChat doesn't support Markdown, so strip formatting.
 */
function markdownToPlainText(md: string): string {
  let text = md;
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/~~(.+?)~~/g, '$1');
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');
  return text;
}

/**
 * Split text into chunks at safe boundaries.
 */
function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

// ─── Factory Function ───────────────────────────────────────────

export function createWechatConnection(
  config: WechatConnectionConfig,
): WechatConnection {
  let running = false;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;
  let getUpdatesBuf: string = config.getUpdatesBuf ?? '';
  let currentOpts: WechatConnectOpts | null = null;

  // Context token tracking: from_user_id → latest context_token
  const contextTokens = new Map<string, string>();

  // Typing ticket cache: from_user_id → typing_ticket
  const typingTickets = new Map<string, string>();

  // Message deduplication
  const msgCache = new Map<string, number>();

  // Backoff state
  let consecutiveFailures = 0;

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    msgCache.set(msgId, Date.now());
  }

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WechatInboundMessage,
    opts: WechatConnectOpts,
  ): Promise<void> {
    // Skip bot's own messages
    if (msg.message_type === 2) return;

    // Generate a dedup key
    const msgId = `${msg.from_user_id}:${msg.message_id ?? msg.seq ?? msg.create_time_ms}`;
    if (isDuplicate(msgId)) return;
    markSeen(msgId);

    // Skip stale messages (hot-reload scenario)
    if (opts.ignoreMessagesBefore && msg.create_time_ms) {
      if (msg.create_time_ms < opts.ignoreMessagesBefore) return;
    }

    // Update context token
    if (msg.context_token) {
      contextTokens.set(msg.from_user_id, msg.context_token);
    }

    const jid = `wechat:${msg.from_user_id}`;
    const senderName = msg.from_user_id.split('@')[0] || 'WeChat User';

    // Extract content from items
    let content = '';
    let attachmentsJson: string | undefined = undefined;

    if (msg.item_list && msg.item_list.length > 0) {
      for (const item of msg.item_list) {
        if (item.type === MessageItemType.TEXT && item.text_item?.text) {
          content += (content ? '\n' : '') + item.text_item.text;
        } else if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
          // Download image
          const media = item.image_item.media;
          if (media.encrypt_query_param && media.aes_key) {
            try {
              const groupFolder = opts.resolveGroupFolder?.(jid);
              const imageBuffer = await downloadMedia(
                media.encrypt_query_param,
                media.aes_key,
              );

              if (imageBuffer.length > MAX_FILE_SIZE) {
                content += (content ? '\n' : '') + '[图片: 文件过大]';
                continue;
              }

              const mimeType = detectImageMimeType(imageBuffer);
              const ext = mimeType.split('/')[1] || 'jpg';
              const fileName = `wechat_image_${Date.now()}.${ext}`;

              if (groupFolder) {
                try {
                  const relPath = await saveDownloadedFile(
                    groupFolder,
                    'wechat',
                    fileName,
                    imageBuffer,
                  );
                  content += (content ? '\n' : '') + `[图片: ${relPath}]`;
                } catch (err) {
                  logger.warn({ err }, 'Failed to save WeChat image to disk');
                  // Fallback to base64
                  const base64 = imageBuffer.toString('base64');
                  attachmentsJson = JSON.stringify([
                    {
                      type: 'image',
                      mediaType: mimeType,
                      data: base64,
                    },
                  ]);
                  content += (content ? '\n' : '') + '[图片]';
                }
              } else {
                // No group folder, use base64 attachment
                const base64 = imageBuffer.toString('base64');
                attachmentsJson = JSON.stringify([
                  {
                    type: 'image',
                    mediaType: mimeType,
                    data: base64,
                  },
                ]);
                content += (content ? '\n' : '') + '[图片]';
              }
            } catch (err) {
              logger.warn({ err }, 'Failed to download WeChat image');
              content += (content ? '\n' : '') + '[图片: 下载失败]';
            }
          } else {
            content += (content ? '\n' : '') + '[图片]';
          }
        } else if (item.type === MessageItemType.FILE && item.file_item) {
          const fileName = item.file_item.file_name || '文件';
          content += (content ? '\n' : '') + `[文件: ${fileName}]`;
        } else if (item.type === MessageItemType.VOICE) {
          content += (content ? '\n' : '') + '[语音]';
        } else if (item.type === MessageItemType.VIDEO) {
          content += (content ? '\n' : '') + '[视频]';
        }
      }
    }

    if (!content) content = '[未知消息类型]';

    // Auto-register chat
    opts.onNewChat(jid, senderName);

    // Check slash commands
    if (content.startsWith('/') && opts.onCommand) {
      const reply = await opts.onCommand(jid, content);
      if (reply) {
        // Command handled, send reply
        const ct = contextTokens.get(msg.from_user_id);
        if (ct) {
          try {
            await sendTextMessage(config.botToken, msg.from_user_id, ct, reply);
          } catch (err) {
            logger.warn({ err }, 'Failed to send WeChat command reply');
          }
        }
        return; // Don't store command messages
      }
      // Unknown command — fall through to store as normal message
    }

    // Route and store message
    const agentRouting = opts.resolveEffectiveChatJid?.(jid);
    const targetJid = agentRouting?.effectiveJid ?? jid;

    const id = crypto.randomUUID();
    const timestamp = msg.create_time_ms
      ? new Date(msg.create_time_ms).toISOString()
      : new Date().toISOString();
    const senderId = `wechat:${msg.from_user_id}`;

    storeChatMetadata(targetJid, timestamp);
    storeMessageDirect(
      id,
      targetJid,
      senderId,
      senderName,
      content,
      timestamp,
      false,
      { attachments: attachmentsJson, sourceJid: jid },
    );

    broadcastNewMessage(
      targetJid,
      {
        id,
        chat_jid: targetJid,
        source_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        attachments: attachmentsJson,
        is_from_me: false,
      },
      agentRouting?.agentId ?? undefined,
    );
    notifyNewImMessage();

    if (agentRouting?.agentId) {
      opts.onAgentMessage?.(jid, agentRouting.agentId);
      logger.info(
        { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
        'WeChat message routed to agent',
      );
    } else {
      logger.info({ jid, sender: senderName, msgId }, 'WeChat message stored');
    }
  }

  // ─── Poll Loop ────────────────────────────────────────────

  async function pollOnce(opts: WechatConnectOpts): Promise<void> {
    try {
      const response = await getUpdates(config.botToken, getUpdatesBuf);

      // Check for session expiry
      if (response.errcode === SESSION_EXPIRED_ERRCODE) {
        logger.warn('WeChat session expired (errcode -14). Disconnecting.');
        running = false;
        return;
      }

      if (response.ret !== undefined && response.ret !== 0) {
        logger.warn(
          { ret: response.ret, errmsg: response.errmsg },
          'WeChat getUpdates returned non-zero ret',
        );
      }

      // Update sync state
      if (response.get_updates_buf) {
        getUpdatesBuf = response.get_updates_buf;
        opts.onSyncStateChanged?.(getUpdatesBuf);
      }

      // Process messages
      if (response.msgs && response.msgs.length > 0) {
        for (const msg of response.msgs) {
          try {
            await processMessage(msg, opts);
          } catch (err) {
            logger.error({ err, from: msg.from_user_id }, 'Error processing WeChat message');
          }
        }
      }

      // Reset backoff on success
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      const backoff = Math.min(
        POLL_BACKOFF_INITIAL_MS * Math.pow(2, consecutiveFailures - 1),
        POLL_BACKOFF_MAX_MS,
      );
      logger.warn(
        { err, attempt: consecutiveFailures, backoffMs: backoff },
        'WeChat poll error, backing off',
      );
      await new Promise((resolve) => {
        pollTimeout = setTimeout(resolve, backoff);
      });
    }
  }

  async function pollLoop(opts: WechatConnectOpts): Promise<void> {
    while (running) {
      await pollOnce(opts);
      if (!running) break;
      // Small delay to prevent tight loop on fast errors
      await new Promise((resolve) => {
        pollTimeout = setTimeout(resolve, POLL_RETRY_IMMEDIATE_MS);
      });
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  return {
    async connect(opts: WechatConnectOpts): Promise<void> {
      if (running) return;
      running = true;
      currentOpts = opts;

      logger.info(
        { botName: config.botName },
        'WeChat connection starting',
      );

      opts.onReady?.();

      // Start poll loop (non-blocking)
      void pollLoop(opts);
    },

    async disconnect(): Promise<void> {
      running = false;
      if (pollTimeout) {
        clearTimeout(pollTimeout);
        pollTimeout = null;
      }
      currentOpts = null;
      contextTokens.clear();
      typingTickets.clear();
      logger.info('WeChat connection disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      // chatId is the raw from_user_id (without wechat: prefix)
      const contextToken = contextTokens.get(chatId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token for WeChat chat, cannot send message. Waiting for next inbound message.',
        );
        return;
      }

      const plainText = markdownToPlainText(text);
      const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

      for (const chunk of chunks) {
        try {
          await sendTextMessage(config.botToken, chatId, contextToken, chunk);
        } catch (err) {
          logger.error({ err, chatId }, 'Failed to send WeChat message');
          throw err;
        }
      }
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!isTyping) return; // No cancel typing API

      try {
        let ticket = typingTickets.get(chatId);
        if (!ticket) {
          const contextToken = contextTokens.get(chatId);
          const configResp = await getConfig(config.botToken, chatId, contextToken);
          if (configResp.typing_ticket) {
            ticket = configResp.typing_ticket;
            typingTickets.set(chatId, ticket);
          }
        }
        if (ticket) {
          await apiSendTyping(config.botToken, chatId, ticket);
        }
      } catch (err) {
        // Typing is best-effort, don't propagate errors
        logger.debug({ err, chatId }, 'Failed to send WeChat typing indicator');
      }
    },

    isConnected(): boolean {
      return running;
    },
  };
}
