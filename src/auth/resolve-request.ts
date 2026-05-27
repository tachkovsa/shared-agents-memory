import { loadMembers, loadNamespace } from '../namespaces/store.js';
import { PatStore } from './pat-store.js';
import { AuthError, type RequestContext } from './request-context.js';
import { ALL_SCOPES, type AgentPat, type AgentScope } from './types.js';

export interface ResolveRequestOptions {
  patStore: PatStore;
  rawSecret: string;
  requestedNamespace: string;
  requiredScope: AgentScope;
  dataDir: string;
}

export interface AuthorizeOptions {
  pat: AgentPat;
  requestedNamespace: string;
  requiredScope: AgentScope;
  dataDir: string;
}

export function resolvePat(patStore: PatStore, rawSecret: string): AgentPat {
  if (!rawSecret) {
    throw new AuthError('missing', 'no bearer token supplied');
  }
  const result = patStore.lookup(rawSecret);
  if (!result.ok) {
    throw new AuthError(
      result.reason,
      `pat lookup failed: ${result.reason}`,
      result.token_prefix,
    );
  }
  return result.pat;
}

export async function authorizeNamespaceAccess(
  opts: AuthorizeOptions,
): Promise<RequestContext> {
  const { pat, requestedNamespace, requiredScope, dataDir } = opts;

  if (!pat.allowed_namespaces.includes(requestedNamespace)) {
    throw new AuthError(
      'namespace_forbidden',
      `namespace "${requestedNamespace}" is not in the token's allowed_namespaces`,
      pat.token_prefix,
      { detail: 'not_in_allowed_namespaces', requestedNamespace },
    );
  }

  const ns = await loadNamespace(dataDir, requestedNamespace);
  if (ns === null) {
    throw new AuthError(
      'namespace_forbidden',
      `namespace "${requestedNamespace}" does not exist`,
      pat.token_prefix,
      { detail: 'namespace_missing', requestedNamespace },
    );
  }

  const members = await loadMembers(dataDir, requestedNamespace);
  const explicitMember = members?.find((m) => m.agent_id === pat.agent_identity);
  const isOwner = pat.agent_identity === ns.owner_agent_id;
  if (!explicitMember && !isOwner) {
    throw new AuthError(
      'namespace_forbidden',
      `agent ${pat.agent_identity} is not a member of namespace "${requestedNamespace}"`,
      pat.token_prefix,
      { detail: 'not_a_member', requestedNamespace },
    );
  }
  const memberScopes: readonly AgentScope[] = explicitMember
    ? explicitMember.scopes
    : ALL_SCOPES;

  const tokenScopes = new Set<AgentScope>(pat.scopes);
  const effective = new Set<AgentScope>();
  for (const scope of memberScopes) {
    if (tokenScopes.has(scope)) effective.add(scope);
  }

  if (!effective.has(requiredScope)) {
    throw new AuthError(
      'scope_insufficient',
      `scope "${requiredScope}" not granted for agent ${pat.agent_identity} on namespace "${requestedNamespace}"`,
      pat.token_prefix,
      { requiredScope, granted: Array.from(effective) },
    );
  }

  return {
    agentId: pat.agent_identity,
    namespaceId: requestedNamespace,
    scopes: Array.from(effective),
    allowedNamespaces: [...pat.allowed_namespaces],
    patId: pat.id,
    tokenPrefix: pat.token_prefix,
  };
}

export async function resolveRequest(
  opts: ResolveRequestOptions,
): Promise<RequestContext> {
  const pat = resolvePat(opts.patStore, opts.rawSecret);
  return authorizeNamespaceAccess({
    pat,
    requestedNamespace: opts.requestedNamespace,
    requiredScope: opts.requiredScope,
    dataDir: opts.dataDir,
  });
}
