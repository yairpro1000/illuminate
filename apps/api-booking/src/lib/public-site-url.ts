import type { Env } from '../env.js';
import type { Logger } from './logger.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PREVIEW_SUFFIX = '.pages.dev';
const ADMIN_PREVIEW_SITE_URL = 'https://illuminate-tw9.pages.dev';

function isAdminPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'admin.letsilluminate.co'
    || host === 'admin.yairb.ch'
    || (host.endsWith(PREVIEW_SUFFIX) && host.includes('admin'));
}

function sanitizeSiteUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function canonicalSiteUrlForHost(hostname: string, protocol: string, port: string): string | null {
  const host = hostname.toLowerCase();
  if (isAdminPreviewHost(host)) return sanitizeSiteUrl(ADMIN_PREVIEW_SITE_URL);
  const hostWithPort = port ? `${host}:${port}` : host;
  if (
    host === 'letsilluminate.co'
    || host === 'www.letsilluminate.co'
    || host === 'yairb.ch'
    || host === 'www.yairb.ch'
  ) {
    return `${protocol}//${hostWithPort}`;
  }
  if (host.endsWith(PREVIEW_SUFFIX) || LOCAL_HOSTS.has(host)) {
    return `${protocol}//${hostWithPort}`;
  }
  return null;
}

function parseCandidateUrl(rawValue: string | null): URL | null {
  if (!rawValue) return null;
  try {
    return new URL(rawValue);
  } catch {
    return null;
  }
}

export interface PublicSiteUrlDecisionInput {
  originHeader: string | null;
  refererHeader: string | null;
  defaultSiteUrl: string;
}

export interface PublicSiteUrlDecision {
  siteUrl: string;
  branchTaken: string;
  denyReason: string | null;
  matchedHeader: 'origin' | 'referer' | null;
  matchedSource: string | null;
  matchedHost: string | null;
}

export function decidePublicSiteUrl(input: PublicSiteUrlDecisionInput): PublicSiteUrlDecision {
  const defaultSiteUrl = sanitizeSiteUrl(input.defaultSiteUrl);
  const originUrl = parseCandidateUrl(input.originHeader);
  if (originUrl) {
    const mapped = canonicalSiteUrlForHost(originUrl.hostname, originUrl.protocol, originUrl.port);
    if (mapped) {
      return {
        siteUrl: mapped,
        branchTaken: 'use_origin_header_site_url',
        denyReason: null,
        matchedHeader: 'origin',
        matchedSource: input.originHeader,
        matchedHost: originUrl.hostname.toLowerCase(),
      };
    }
  }

  const refererUrl = parseCandidateUrl(input.refererHeader);
  if (refererUrl) {
    const mapped = canonicalSiteUrlForHost(refererUrl.hostname, refererUrl.protocol, refererUrl.port);
    if (mapped) {
      return {
        siteUrl: mapped,
        branchTaken: 'use_referer_header_site_url',
        denyReason: null,
        matchedHeader: 'referer',
        matchedSource: input.refererHeader,
        matchedHost: refererUrl.hostname.toLowerCase(),
      };
    }
  }

  return {
    siteUrl: defaultSiteUrl,
    branchTaken: 'fallback_env_site_url',
    denyReason: originUrl || refererUrl ? 'request_site_host_not_supported' : 'request_site_headers_missing',
    matchedHeader: null,
    matchedSource: null,
    matchedHost: originUrl?.hostname?.toLowerCase() ?? refererUrl?.hostname?.toLowerCase() ?? null,
  };
}

export function resolvePublicSiteUrl(
  request: Request,
  env: Pick<Env, 'SITE_URL'>,
  logger?: Logger,
): string {
  const originHeader = request.headers.get('Origin');
  const refererHeader = request.headers.get('Referer');

  const decision = decidePublicSiteUrl({
    originHeader,
    refererHeader,
    defaultSiteUrl: env.SITE_URL,
  });
  if (decision.denyReason) {
    logger?.logWarn?.({
      source: 'backend',
      eventType: 'public_site_url_resolution_fallback',
      message: 'Fell back to default public site URL for request-scoped booking links',
      context: {
        path: new URL(request.url).pathname,
        request_origin: originHeader,
        request_referer: refererHeader,
        resolved_site_url: decision.siteUrl,
        matched_header: decision.matchedHeader,
        matched_header_value: decision.matchedSource,
        matched_host: decision.matchedHost,
        branch_taken: decision.branchTaken,
        deny_reason: decision.denyReason,
      },
    });
  }

  return decision.siteUrl;
}
