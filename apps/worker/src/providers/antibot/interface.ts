export interface IAntiBotProvider {
  /**
   * Verifies a CAPTCHA token from a public form submission.
   * Throws ApiError(400) if the token is invalid or missing.
   */
  verify(token: string, remoteIp?: string | null): Promise<void>;
}
