/**
 * WeChat iLink Bot API Client
 *
 * Pure HTTP client for Tencent's iLink Bot API (personal WeChat).
 * Endpoints: getupdates, sendmessage, getconfig, sendtyping, getuploadurl
 * QR login: get_bot_qrcode, get_qrcode_status
 * Media: AES-128-ECB encrypted CDN upload/download
 *
 * Zero HappyClaw dependencies — testable in isolation.
 */
import crypto from 'crypto';
import https from 'node:https';
import { logger } from './logger.js';

// ─── Constants ──────────────────────────────────────────────────

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const CHANNEL_VERSION = '1.0.0';
const LONG_POLL_TIMEOUT_MS = 40_000; // 35s server + 5s buffer
const SEND_TIMEOUT_MS = 15_000;
const SESSION_EXPIRED_ERRCODE = -14;

// ─── Types ──────────────────────────────────────────────────────

/** Message item types in iLink protocol */
export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export interface WechatMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: {
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      encrypt_type?: number;
    };
    mid_size?: number;
  };
  voice_item?: {
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      encrypt_type?: number;
    };
  };
  file_item?: {
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      encrypt_type?: number;
    };
    file_name?: string;
    len?: number;
  };
  video_item?: {
    media?: {
      encrypt_query_param?: string;
      aes_key?: string;
      encrypt_type?: number;
    };
  };
  create_time_ms?: number;
}

export interface WechatInboundMessage {
  seq?: number;
  message_id?: number;
  from_user_id: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  context_token: string;
  item_list?: WechatMessageItem[];
}

export interface WechatGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatInboundMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WechatSendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export interface WechatGetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WechatQRCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface WechatQRStatusResponse {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

// ─── AES-128-ECB Helpers ────────────────────────────────────────

/**
 * Decrypt AES-128-ECB encrypted data (used for WeChat CDN media download).
 * Key can be raw 16-byte buffer or base64-encoded.
 */
export function decryptAesEcb(ciphertext: Buffer, keyInput: string): Buffer {
  const key = parseAesKey(keyInput);
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt data with AES-128-ECB (used for WeChat CDN media upload).
 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Calculate AES-128-ECB padded ciphertext size (PKCS7 padding to 16-byte boundary).
 */
export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parse AES key from various formats used by WeChat API:
 * - Base64 of 16 raw bytes (images)
 * - Base64 of hex string (file/voice/video)
 */
function parseAesKey(keyInput: string): Buffer {
  const decoded = Buffer.from(keyInput, 'base64');
  if (decoded.length === 16) return decoded;
  // Try hex interpretation: base64 → hex string → 16 bytes
  const hexStr = decoded.toString('utf-8');
  if (/^[0-9a-fA-F]{32}$/.test(hexStr)) {
    return Buffer.from(hexStr, 'hex');
  }
  // Fallback: use first 16 bytes
  return decoded.subarray(0, 16);
}

// ─── HTTP Helpers ───────────────────────────────────────────────

function generateUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildAuthHeaders(botToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
    'X-WECHAT-UIN': generateUin(),
  };
}

function httpsRequest(
  options: https.RequestOptions,
  body?: string | Buffer,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function apiPost<T>(
  baseUrl: string,
  path: string,
  botToken: string,
  body: Record<string, unknown>,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(path, baseUrl);
  const bodyStr = JSON.stringify(body);
  const headers = buildAuthHeaders(botToken);
  headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

  const result = await httpsRequest(
    {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers,
    },
    bodyStr,
    timeoutMs,
  );

  try {
    return JSON.parse(result.body.toString('utf-8')) as T;
  } catch {
    if (result.statusCode >= 400) {
      throw new Error(`WeChat API ${path} failed (${result.statusCode}): ${result.body.toString('utf-8')}`);
    }
    return {} as T;
  }
}

async function apiGet<T>(
  baseUrl: string,
  path: string,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(path, baseUrl);

  const result = await httpsRequest(
    {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'iLink-App-ClientVersion': '1' },
    },
    undefined,
    timeoutMs,
  );

  return JSON.parse(result.body.toString('utf-8')) as T;
}

// ─── API Functions ──────────────────────────────────────────────

/** Long-poll for inbound messages. Returns when messages arrive or after ~35s timeout. */
export async function getUpdates(
  botToken: string,
  getUpdatesBuf?: string,
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatGetUpdatesResponse> {
  return apiPost<WechatGetUpdatesResponse>(
    baseUrl,
    '/ilink/bot/getupdates',
    botToken,
    {
      get_updates_buf: getUpdatesBuf ?? '',
      base_info: { channel_version: CHANNEL_VERSION },
    },
    LONG_POLL_TIMEOUT_MS,
  );
}

/** Send a text or media message to a WeChat user. */
export async function sendMessage(
  botToken: string,
  toUserId: string,
  contextToken: string,
  items: WechatMessageItem[],
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatSendMessageResponse> {
  return apiPost<WechatSendMessageResponse>(
    baseUrl,
    '/ilink/bot/sendmessage',
    botToken,
    {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `happyclaw-${crypto.randomUUID()}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken,
        item_list: items,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
  );
}

/** Send a text-only message (convenience wrapper). */
export async function sendTextMessage(
  botToken: string,
  toUserId: string,
  contextToken: string,
  text: string,
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatSendMessageResponse> {
  return sendMessage(botToken, toUserId, contextToken, [
    { type: MessageItemType.TEXT, text_item: { text } },
  ], baseUrl);
}

/** Get bot config (typing_ticket for a given user). */
export async function getConfig(
  botToken: string,
  ilinkUserId: string,
  contextToken?: string,
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatGetConfigResponse> {
  return apiPost<WechatGetConfigResponse>(
    baseUrl,
    '/ilink/bot/getconfig',
    botToken,
    {
      ilink_user_id: ilinkUserId,
      ...(contextToken ? { context_token: contextToken } : {}),
      base_info: { channel_version: CHANNEL_VERSION },
    },
    10_000,
  );
}

/** Send typing indicator. */
export async function sendTyping(
  botToken: string,
  ilinkUserId: string,
  typingTicket: string,
  status: 1 | 2 = 1, // 1=start, 2=cancel
  baseUrl: string = WECHAT_API_BASE,
): Promise<void> {
  await apiPost(
    baseUrl,
    '/ilink/bot/sendtyping',
    botToken,
    {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: CHANNEL_VERSION },
    },
    10_000,
  );
}

// ─── QR Code Login ──────────────────────────────────────────────

/** Start QR login: fetch a QR code for user to scan with WeChat. */
export async function getQRCode(
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatQRCodeResponse> {
  return apiGet<WechatQRCodeResponse>(
    baseUrl,
    '/ilink/bot/get_bot_qrcode?bot_type=3',
  );
}

/** Poll QR scan status (long-poll, ~35s timeout). */
export async function pollQRStatus(
  qrcode: string,
  baseUrl: string = WECHAT_API_BASE,
): Promise<WechatQRStatusResponse> {
  return apiGet<WechatQRStatusResponse>(
    baseUrl,
    `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    LONG_POLL_TIMEOUT_MS,
  );
}

// ─── CDN Media Download ─────────────────────────────────────────

/**
 * Download and decrypt media from WeChat CDN.
 * @param encryptQueryParam - the encrypt_query_param from message item's media field
 * @param aesKey - the AES key (base64 encoded) from message item's media field
 * @param cdnBase - CDN base URL (default: https://novac2c.cdn.weixin.qq.com/c2c)
 */
export async function downloadMedia(
  encryptQueryParam: string,
  aesKey: string,
  cdnBase: string = WECHAT_CDN_BASE,
): Promise<Buffer> {
  const url = new URL(`${cdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`);

  const result = await httpsRequest(
    {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
    },
    undefined,
    30_000,
  );

  if (result.statusCode >= 400) {
    throw new Error(`WeChat CDN download failed (${result.statusCode})`);
  }

  return decryptAesEcb(result.body, aesKey);
}

// ─── Exports ────────────────────────────────────────────────────

export { SESSION_EXPIRED_ERRCODE };
