import { ENABLE_ACP } from '../config.js';
import type { ProviderConfig } from '../provider.js';
import { AcpEngineAdapter } from './acp-adapter.js';
import { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';
import type { AgentEngine } from './types.js';

export * from './types.js';
export { AcpEngineAdapter, getAcpCommand } from './acp-adapter.js';
export { ClaudeSdkEngineAdapter } from './claude-sdk-adapter.js';

export class EngineFactory {
  static forProvider(provider: ProviderConfig): AgentEngine {
    // ENABLE_ACP gates the ACP engine path. When off, always return the
    // Claude SDK adapter even if a non-Claude provider somehow leaks through
    // (stale config, race during a flag flip, etc.).
    if (!ENABLE_ACP) return new ClaudeSdkEngineAdapter();
    if (provider.type === 'claude') return new ClaudeSdkEngineAdapter();
    return new AcpEngineAdapter();
  }
}

