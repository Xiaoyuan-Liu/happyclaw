import { describe, expect, it } from 'vitest';
import {
  diagnoseProviderError,
  diagnosticToLogLine,
} from '../../src/provider-diagnostics.js';

describe('diagnoseProviderError', () => {
  describe('invalid_beta', () => {
    it('detects "invalid beta flag" in stderr', () => {
      const d = diagnoseProviderError({
        errorText:
          '400 Bad Request: invalid beta flag: advanced-tool-use-2025-11-20',
      });
      expect(d).not.toBeNull();
      expect(d!.kind).toBe('invalid_beta');
      expect(d!.suggestedAction).toBe('enable_disable_experimental_betas');
      expect(d!.hint).toMatch(/禁用实验 beta/);
    });

    it('is case-insensitive', () => {
      const d = diagnoseProviderError({
        errorText: 'Invalid Beta Flag returned by upstream',
      });
      expect(d?.kind).toBe('invalid_beta');
    });
  });

  describe('unsupported_beta', () => {
    it('detects "unsupported beta" message', () => {
      const d = diagnoseProviderError({
        errorText: 'Error 400: unsupported beta header in request',
      });
      expect(d?.kind).toBe('unsupported_beta');
      expect(d?.hint).toMatch(/bedrock_gateway|vertex_gateway|禁用实验 beta/);
    });

    it('detects "anthropic-beta unrecognized" pair', () => {
      const d = diagnoseProviderError({
        errorText:
          'gateway responded: anthropic-beta header value is unrecognized by backend',
      });
      expect(d?.kind).toBe('unsupported_beta');
    });
  });

  describe('bedrock_auth', () => {
    it('detects bedrock + unauthorized', () => {
      const d = diagnoseProviderError({
        errorText:
          'Bedrock InvokeModel returned 401 Unauthorized: token expired',
      });
      expect(d?.kind).toBe('bedrock_auth');
      expect(d?.suggestedAction).toBe('check_aws_credentials');
      expect(d?.hint).toMatch(/AWS|IAM/);
    });

    it('detects AccessDeniedException via errorCode', () => {
      const d = diagnoseProviderError({
        errorText: 'request failed',
        errorCode: 'AccessDeniedException',
      });
      expect(d?.kind).toBe('bedrock_auth');
    });

    it('detects bedrock 403', () => {
      const d = diagnoseProviderError({
        errorText: 'bedrock-runtime returned forbidden response',
      });
      expect(d?.kind).toBe('bedrock_auth');
    });
  });

  describe('vertex_auth', () => {
    it('detects vertex + unauthorized', () => {
      const d = diagnoseProviderError({
        errorText: 'Vertex AI rawPredict failed: unauthorized client',
      });
      expect(d?.kind).toBe('vertex_auth');
      expect(d?.suggestedAction).toBe('check_gcp_credentials');
    });

    it('detects ADC missing', () => {
      const d = diagnoseProviderError({
        errorText: 'Could not load default credentials from environment',
      });
      expect(d?.kind).toBe('vertex_auth');
      expect(d?.hint).toMatch(/GOOGLE_APPLICATION_CREDENTIALS|ADC/);
    });
  });

  describe('foundry_auth', () => {
    it('detects foundry + unauthorized', () => {
      const d = diagnoseProviderError({
        errorText: 'Microsoft Foundry endpoint returned 401 Unauthorized',
      });
      expect(d?.kind).toBe('foundry_auth');
      expect(d?.suggestedAction).toBe('check_azure_credentials');
    });

    it('detects azure invalid_api_key', () => {
      const d = diagnoseProviderError({
        errorText: 'azure error: invalid_api_key for given deployment',
      });
      expect(d?.kind).toBe('foundry_auth');
    });
  });

  describe('null cases', () => {
    it('returns null for empty input', () => {
      expect(diagnoseProviderError({})).toBeNull();
      expect(diagnoseProviderError({ errorText: '' })).toBeNull();
    });

    it('returns null for unrelated error text', () => {
      const d = diagnoseProviderError({
        errorText: 'connection reset by peer',
      });
      expect(d).toBeNull();
    });

    it('returns null when only one of multi-needle rule matches', () => {
      // bedrock alone is not enough; needs unauthorized/forbidden
      const d = diagnoseProviderError({
        errorText: 'bedrock initialization succeeded',
      });
      expect(d).toBeNull();
    });
  });

  describe('priority / first-match-wins', () => {
    it('matches invalid_beta before generic unsupported_beta', () => {
      // both "invalid beta flag" and "unsupported beta" present;
      // RULES order puts invalid_beta first
      const d = diagnoseProviderError({
        errorText:
          'gateway: invalid beta flag detected; upstream sent unsupported beta',
      });
      expect(d?.kind).toBe('invalid_beta');
    });
  });

  describe('diagnosticToLogLine', () => {
    it('produces a single-line summary', () => {
      const d = diagnoseProviderError({
        errorText: 'invalid beta flag: foo',
      });
      const line = diagnosticToLogLine(d!);
      expect(line).toMatch(/^\[invalid_beta\]/);
      expect(line.includes('\n')).toBe(false);
    });
  });
});
