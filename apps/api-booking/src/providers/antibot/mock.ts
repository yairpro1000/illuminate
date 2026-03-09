import type { IAntiBotProvider } from './interface.js';

/** Always passes — no CAPTCHA required in mock mode. */
export class MockAntiBotProvider implements IAntiBotProvider {
  async verify(_token: string, _remoteIp?: string | null): Promise<void> {
    // no-op
  }
}
