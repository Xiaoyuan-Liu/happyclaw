import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface UserWechatConfig {
  botName: string | null;
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

interface QRLoginState {
  status: 'idle' | 'loading' | 'scanning' | 'scanned' | 'confirmed' | 'expired' | 'error';
  qrcodeUrl: string | null;
  qrcode: string | null;
  errorMessage?: string;
}

interface WechatChannelCardProps extends SettingsNotification {}

export function WechatChannelCard({ setNotice, setError }: WechatChannelCardProps) {
  const [config, setConfig] = useState<UserWechatConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrLogin, setQrLogin] = useState<QRLoginState>({
    status: 'idle',
    qrcodeUrl: null,
    qrcode: null,
  });

  const pollingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserWechatConfig>('/api/config/user-im/wechat');
      setConfig(data);
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      pollingRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    setNotice(null);
    setError(null);
    try {
      const data = await api.put<UserWechatConfig>('/api/config/user-im/wechat', { enabled: newEnabled });
      setConfig(data);
      setNotice(`微信渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      setError(getErrorMessage(err, '切换微信渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const startQRLogin = async () => {
    setError(null);
    setNotice(null);
    setQrLogin({ status: 'loading', qrcodeUrl: null, qrcode: null });

    try {
      const result = await api.post<{ qrcode: string; qrcodeUrl: string | null }>(
        '/api/config/user-im/wechat/qr-login',
      );

      if (!result.qrcode) {
        setQrLogin({ status: 'error', qrcodeUrl: null, qrcode: null, errorMessage: '获取二维码失败' });
        return;
      }

      setQrLogin({
        status: 'scanning',
        qrcodeUrl: result.qrcodeUrl,
        qrcode: result.qrcode,
      });

      // Start polling for QR status
      pollQRStatus(result.qrcode);
    } catch (err) {
      setQrLogin({
        status: 'error',
        qrcodeUrl: null,
        qrcode: null,
        errorMessage: getErrorMessage(err, '启动扫码登录失败'),
      });
    }
  };

  const pollQRStatus = async (qrcode: string) => {
    pollingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    let retries = 0;
    const maxRetries = 20; // ~35s * 20 = ~700s max

    while (pollingRef.current && retries < maxRetries) {
      try {
        const result = await api.get<{
          status: 'wait' | 'scaned' | 'confirmed' | 'expired';
          botName?: string;
          connected?: boolean;
        }>(`/api/config/user-im/wechat/qr-status?qrcode=${encodeURIComponent(qrcode)}`);

        if (!pollingRef.current) break;

        if (result.status === 'confirmed') {
          setQrLogin({ status: 'confirmed', qrcodeUrl: null, qrcode: null });
          setNotice(`微信登录成功${result.botName ? `（${result.botName}）` : ''}`);
          pollingRef.current = false;
          // Reload config to show new state
          await loadConfig();
          return;
        }

        if (result.status === 'scaned') {
          setQrLogin((prev) => ({ ...prev, status: 'scanned' }));
        }

        if (result.status === 'expired') {
          setQrLogin({
            status: 'expired',
            qrcodeUrl: null,
            qrcode: null,
          });
          pollingRef.current = false;
          return;
        }

        retries++;
      } catch {
        // Timeout or network error — retry
        retries++;
        if (!pollingRef.current) break;
      }
    }

    if (pollingRef.current) {
      setQrLogin({ status: 'expired', qrcodeUrl: null, qrcode: null });
      pollingRef.current = false;
    }
  };

  const cancelQRLogin = () => {
    pollingRef.current = false;
    abortRef.current?.abort();
    setQrLogin({ status: 'idle', qrcodeUrl: null, qrcode: null });
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/api/config/user-im/wechat/disconnect');
      setNotice('微信已断开连接');
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '断开微信连接失败'));
    } finally {
      setDisconnecting(false);
    }
  };

  const statusText = (() => {
    switch (qrLogin.status) {
      case 'loading': return '正在获取二维码...';
      case 'scanning': return '请用微信扫描二维码';
      case 'scanned': return '已扫码，请在手机上确认';
      case 'confirmed': return '登录成功！';
      case 'expired': return '二维码已过期';
      case 'error': return qrLogin.errorMessage || '登录失败';
      default: return null;
    }
  })();

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">微信</h3>
            <p className="text-xs text-slate-500 mt-0.5">通过微信 iLink Bot 接收和回复消息</p>
          </div>
        </div>
        <ToggleSwitch checked={enabled} disabled={loading || toggling} onChange={handleToggle} />
      </div>

      <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {/* Current account status */}
            <div className="text-sm text-slate-700">
              当前账号：
              {config?.hasBotToken ? (
                <span className="font-medium text-slate-900">
                  {config.botName || '已登录'}
                  {config.connected && (
                    <span className="ml-2 text-xs text-emerald-600">● 已连接</span>
                  )}
                  {!config.connected && (
                    <span className="ml-2 text-xs text-amber-600">● 未连接</span>
                  )}
                </span>
              ) : (
                <span className="text-slate-400">未登录</span>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-3">
              {(!config?.hasBotToken || !config?.connected) && (
                <Button
                  onClick={startQRLogin}
                  disabled={qrLogin.status === 'loading' || qrLogin.status === 'scanning' || qrLogin.status === 'scanned'}
                >
                  {(qrLogin.status === 'loading') && <Loader2 className="size-4 animate-spin" />}
                  扫码登录
                </Button>
              )}
              {config?.hasBotToken && (
                <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting && <Loader2 className="size-4 animate-spin" />}
                  断开连接
                </Button>
              )}
            </div>

            {/* QR Code display */}
            {(qrLogin.status === 'scanning' || qrLogin.status === 'scanned') && (
              <div className="border border-slate-200 rounded-lg p-4 bg-white text-center space-y-3">
                {qrLogin.qrcodeUrl ? (
                  <QRCodeSVG
                    value={qrLogin.qrcodeUrl}
                    size={192}
                    className="mx-auto"
                  />
                ) : (
                  <div className="mx-auto w-48 h-48 flex items-center justify-center bg-slate-100 rounded">
                    <span className="text-sm text-slate-400">二维码加载中...</span>
                  </div>
                )}
                <p className="text-sm text-slate-600">
                  {qrLogin.status === 'scanned' ? '已扫码，请在手机上确认' : '请用微信扫描上方二维码'}
                </p>
                <Button variant="ghost" size="sm" onClick={cancelQRLogin}>
                  取消
                </Button>
              </div>
            )}

            {/* Status messages */}
            {statusText && qrLogin.status !== 'scanning' && qrLogin.status !== 'scanned' && qrLogin.status !== 'idle' && (
              <div className={`text-sm ${
                qrLogin.status === 'confirmed' ? 'text-emerald-600' :
                qrLogin.status === 'expired' || qrLogin.status === 'error' ? 'text-amber-600' :
                'text-slate-500'
              }`}>
                {statusText}
                {qrLogin.status === 'expired' && (
                  <Button variant="link" size="sm" className="ml-2 p-0 h-auto" onClick={startQRLogin}>
                    重新获取
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
