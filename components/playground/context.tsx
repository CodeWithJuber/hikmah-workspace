'use client';
import { parseKnowledge, type KnowledgeItem } from '@/lib/playground/knowledge';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  useCallback,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  initialModel,
  defaultProvider,
  defaultPreferences,
  parsePreferences,
  starterFiles,
  parseSession,
  fitAdditions,
  type ProviderConfig,
  type Conversation,
  type WorkspaceFiles,
  type SavedSession,
  type Preferences,
  type ChatMode,
} from '@/lib/playground/session';
import { type Model, type TrainingRow } from '@/lib/engines/meaning-engine';
import { listModels, type ModelInfo } from '@/lib/playground/transport';
import {
  defaultWorkspaceConfig,
  parseWorkspaceConfig,
  type WorkspaceConfig,
} from '@/lib/playground/workspace-config';
import { prepareConnectors } from '@/lib/playground/run-preparation';
import type { McpConnection } from '@/lib/playground/workspace-config';
import { connectMcp, type McpTool } from '@/lib/playground/mcp-client';
import { readWorkspaceSession, saveWorkspaceSession } from '@/lib/playground/storage';
import { canPublishTheme, themeCookie } from '@/lib/theme';
import { clientFetch } from '@/lib/client/request';
type Setter<T> = Dispatch<SetStateAction<T>>;
type AppContext = {
  prepareRunConnections: (
    connections: McpConnection[],
    signal: AbortSignal,
  ) => Promise<Record<string, McpTool[]>>;
  sharedKnowledge: KnowledgeItem[];
  refreshSharedKnowledge: () => Promise<KnowledgeItem[]>;
  connectorStatus: Record<string, { status: 'ready' | 'error'; message: string; at: number }>;
  knowledge: KnowledgeItem[];
  setKnowledge: Setter<KnowledgeItem[]>;
  workspaceLoaded: boolean;
  workspace: WorkspaceConfig;
  setWorkspace: Setter<WorkspaceConfig>;
  mediaKey: string;
  setMediaKey: Setter<string>;
  connectorKeys: Record<string, string>;
  setConnectorKeys: Setter<Record<string, string>>;
  connectorTools: Record<string, McpTool[]>;
  connectConnector: (id: string) => Promise<void>;
  model: Model;
  additions: TrainingRow[];
  experimental: boolean;
  applyRows: (r: TrainingRow[], experimental?: boolean) => void;
  provider: ProviderConfig;
  setProvider: Setter<ProviderConfig>;
  conversations: Conversation[];
  setConversations: Setter<Conversation[]>;
  files: WorkspaceFiles;
  setFiles: Setter<WorkspaceFiles>;
  session: () => SavedSession;
  importSession: (text: string) => void;
  storageMessage: string;
  /** The stored workspace could not be read, so nothing is being saved. */
  restoreFailed: boolean;
  openSettings: () => void;
  preferences: Preferences;
  setPreferences: Setter<Preferences>;
  activeId: string;
  setActiveId: Setter<string>;
  mode: ChatMode;
  setMode: Setter<ChatMode>;
  models: ModelInfo[];
  setModels: Setter<ModelInfo[]>;
  modelsLoading: boolean;
  modelsError: string;
  modelsLoadedAt: number;
  refreshModels: () => Promise<void>;
  runSettingsOpen: boolean;
  setRunSettingsOpen: Setter<boolean>;
};
const Context = createContext<AppContext | null>(null);
export function PlaygroundProvider({
  children,
  onSettings,
}: {
  children: ReactNode;
  onSettings: () => void;
}) {
  const [sharedKnowledge, setSharedKnowledge] = useState<KnowledgeItem[]>([]);
  const refreshSharedKnowledge = async () => {
    const r = await clientFetch('/api/shared-knowledge', {
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw Error('Shared knowledge unavailable.');
    const data = (await r.json()) as { items: unknown };
    const items = parseKnowledge(data.items);
    setSharedKnowledge(items);
    return items;
  };
  useEffect(() => {
    void refreshSharedKnowledge().catch(() => {});
  }, []);
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([]);
  const [additions, setAdditions] = useState<TrainingRow[]>([]);
  const [experimental, setExperimental] = useState(false);
  const [provider, setProvider] = useState(defaultProvider);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [files, setFiles] = useState(starterFiles);
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const restoreFailed = useRef(false);
  // Mirrored into state because a ref cannot re-render, and this has to be
  // visible: the ref alone left the screen looking like an ordinary empty
  // workspace while saving was silently switched off.
  const [restoreError, setRestoreError] = useState(false);
  const [storageMessage, setStorageMessage] = useState('Loading your workspace…');
  const [workspace, setWorkspace] = useState<WorkspaceConfig>(() =>
    structuredClone(defaultWorkspaceConfig),
  );
  const [mediaKey, setMediaKey] = useState('');
  const [connectorKeys, setConnectorKeys] = useState<Record<string, string>>({});
  const [connectorTools, setConnectorTools] = useState<Record<string, McpTool[]>>({});
  const [connectorStatus, setConnectorStatus] = useState<
    Record<string, { status: 'ready' | 'error'; message: string; at: number }>
  >({});
  const connectorState = useRef({ workspace, connectorKeys });
  connectorState.current = { workspace, connectorKeys };
  const connectorFingerprints = useRef<Record<string, string>>({});
  const fingerprint = (id: string) => {
    const connection = connectorState.current.workspace.connectors.find((c) => c.id === id);
    return connection
      ? JSON.stringify([
          connection.url,
          connection.protocol,
          connection.secretRef,
          connectorState.current.connectorKeys[id] ?? '',
        ])
      : '';
  };
  useEffect(() => {
    setConnectorTools((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const id of Object.keys(previous))
        if (connectorFingerprints.current[id] !== fingerprint(id)) {
          delete next[id];
          delete connectorFingerprints.current[id];
          changed = true;
        }
      return changed ? next : previous;
    });
  }, [workspace.connectors, connectorKeys]);
  const connectConnector = async (id: string) => {
    const connection = workspace.connectors.find((c) => c.id === id);
    if (!connection) throw Error('Connector not found.');
    const at = fingerprint(id);
    try {
      const list = await connectMcp(connection, connectorKeys[id] ?? '');
      if (at !== fingerprint(id)) throw Error('Connector settings changed. Connect again.');
      connectorFingerprints.current[id] = at;
      setConnectorTools((previous) => ({ ...previous, [id]: list }));
      setConnectorStatus((p) => ({
        ...p,
        [id]: { status: 'ready', message: 'Tools discovered', at: Date.now() },
      }));
    } catch (e) {
      setConnectorTools((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
      setConnectorStatus((p) => ({
        ...p,
        [id]: {
          status: 'error',
          message: e instanceof Error ? e.message : 'Connection failed',
          at: Date.now(),
        },
      }));
      throw e;
    }
  };

  const prepareRunConnections = async (connections: McpConnection[], signal: AbortSignal) => {
    const stamps = Object.fromEntries(connections.map((c) => [c.id, fingerprint(c.id)]));
    const result = await prepareConnectors(connections, connectorKeys, connectorTools, signal);
    for (const c of connections)
      if (stamps[c.id] !== fingerprint(c.id)) {
        delete result.catalogs[c.id];
        result.failures.push({
          id: c.id,
          name: c.name,
          message: 'Connection changed during preparation. Try again.',
        });
      }
    for (const c of connections)
      if (result.catalogs[c.id]?.length) connectorFingerprints.current[c.id] = fingerprint(c.id);
    setConnectorTools((p) => ({ ...p, ...result.catalogs }));
    setConnectorStatus((p) => ({
      ...p,
      ...Object.fromEntries(
        connections.map((c) => {
          const failed = result.failures.find((f) => f.id === c.id);
          return [
            c.id,
            {
              status: failed ? ('error' as const) : ('ready' as const),
              message: failed?.message ?? 'Tools discovered',
              at: Date.now(),
            },
          ];
        }),
      ),
    }));
    return result.catalogs;
  };
  useEffect(() => {
    if (!loaded) return;
    let current = true;
    const refresh = () => {
      void clientFetch('/api/runtime', { timeoutMs: 4000, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (current && data?.configured)
            setWorkspace((w) =>
              w.connectors.some((c) => c.id === 'hikmah-runtime')
                ? w
                : {
                    ...w,
                    connectors: [
                      ...w.connectors,
                      {
                        id: 'hikmah-runtime',
                        name: 'Server runtime',
                        url: '/api/runtime',
                        protocol: '2025-11-25',
                        enabled: true,
                        approval: 'ask',
                        purpose: 'ssh',
                      },
                    ],
                  },
            );
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('hikmah-secrets-changed', refresh);
    return () => {
      current = false;
      window.removeEventListener('hikmah-secrets-changed', refresh);
    };
  }, [loaded]);
  const [activeId, setActiveId] = useState('');
  const [mode, setMode] = useState<ChatMode>('chat');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelsLoadedAt, setModelsLoadedAt] = useState(0);
  const catalogAbort = useRef<AbortController | null>(null);
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const model = useMemo(
    () => (additions.length ? fitAdditions(additions) : initialModel),
    [additions],
  );
  const applyRows = (r: TrainingRow[], experimental = false) => {
    if (r.length > 400) throw Error('At most 400 additional examples.');
    fitAdditions(r);
    setAdditions(r);
    setExperimental(experimental);
  };
  const session = (): SavedSession => ({
    version: 1,
    knowledge,
    additions,
    experimental,
    conversations,
    files,
    preferences,
    workspace,
    connection: {
      apiKeySecret: provider.apiKeySecret,
      freeOnly: provider.freeOnly,
      baseUrl: provider.baseUrl,
      model: provider.model,
      maxTokens: provider.maxTokens,
      temperature: provider.temperature,
      reasoningEffort: provider.reasoningEffort ?? 'default',
      customSampling: provider.customSampling === true,
      stream: provider.stream !== false,
      tokenParameter: provider.tokenParameter ?? 'max_tokens',
    },
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const restore = (s: SavedSession) => {
    setKnowledge(parseKnowledge(s.knowledge));
    fitAdditions(s.additions);
    setAdditions(s.additions);
    setExperimental(s.experimental);
    setConversations(s.conversations);
    setFiles(s.files);
    setProvider({ ...s.connection, apiKey: '' });
    setPreferences(parsePreferences(s.preferences));
    setWorkspace(parseWorkspaceConfig(s.workspace));
    setMediaKey('');
    setConnectorKeys({});
    setConnectorTools({});
    setActiveId(s.conversations[0]?.id ?? '');
  };
  const cloudRevision = useRef(-1);
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const response = await clientFetch('/api/workspace-state', { cache: 'no-store' });
      const data = (await response.json()) as {
        session?: string;
        revision: number;
        error?: string;
      };
      if (!response.ok) throw Error(data.error);
      cloudRevision.current = data.revision;
      const raw = data.session ?? (await readWorkspaceSession());
      if (mounted && raw) restore(parseSession(raw));
    })()
      .catch(() => {
        restoreFailed.current = true;
        setRestoreError(true);
        setStorageMessage('Workspace not loaded — saving is off');
      })
      .finally(() => {
        if (mounted) setLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    // Not before the saved session arrives: see canPublishTheme. Until then
    // `preferences` is the default object and its theme is `light`, which would
    // overwrite what the layout stamped from the cookie and then persist.
    if (!canPublishTheme({ loaded, restoreFailed: restoreError })) return;
    document.documentElement.dataset.theme = preferences.theme;
    // Mirrored into a cookie so the server can stamp the same theme on the next
    // page load, before anything paints, and so /chat picks it up without
    // mounting this provider.
    document.cookie = themeCookie(preferences.theme);
  }, [loaded, restoreError, preferences.theme]);
  useEffect(() => {
    catalogAbort.current?.abort();
    setModels([]);
    setModelsError('');
    setModelsLoading(false);
    setModelsLoadedAt(0);
  }, [provider.baseUrl, provider.apiKey, provider.apiKeySecret]);
  useEffect(() => {
    const refresh = () => {
      setConnectorTools({});
      connectorFingerprints.current = {};
      catalogAbort.current?.abort();
      setModels([]);
      setModelsError('');
      setModelsLoadedAt(0);
    };
    window.addEventListener('hikmah-secrets-changed', refresh);
    return () => window.removeEventListener('hikmah-secrets-changed', refresh);
  }, []);
  const refreshModels = useCallback(async () => {
    if (catalogAbort.current) catalogAbort.current.abort();
    const controller = new AbortController();
    catalogAbort.current = controller;
    setModelsLoading(true);
    setModelsError('');
    try {
      const rows = await listModels(provider, controller.signal);
      if (!controller.signal.aborted) {
        setModels(rows);
        setModelsLoadedAt(Date.now());
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setModelsError(e instanceof Error ? e.message : 'Could not load the model catalog.');
    } finally {
      if (catalogAbort.current === controller) {
        setModelsLoading(false);
        catalogAbort.current = null;
      }
    }
  }, [provider]);
  const revision = useRef(0);
  const savedRevision = useRef(-1);
  useEffect(() => {
    revision.current++;
  }, [
    knowledge,
    additions,
    experimental,
    conversations,
    files,
    preferences,
    workspace,
    provider.freeOnly,
    provider.baseUrl,
    provider.apiKeySecret,
    provider.model,
    provider.maxTokens,
    provider.temperature,
    provider.reasoningEffort,
    provider.customSampling,
    provider.stream,
    provider.tokenParameter,
  ]);
  useEffect(() => {
    if (!loaded) return;
    let saving = false;
    let disposed = false;
    const save = async () => {
      if (restoreFailed.current || saving || savedRevision.current === revision.current) return;
      saving = true;
      const at = revision.current;
      try {
        const serialized = JSON.stringify(sessionRef.current());
        try {
          await saveWorkspaceSession(serialized);
        } catch {
          /* Device quota must not block authenticated cloud persistence. */
        }
        const response = await clientFetch('/api/workspace-state', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: serialized, revision: cloudRevision.current }),
        });
        const data = (await response.json()) as {
          session?: string;
          revision: number;
          error?: string;
        };
        if (!response.ok) {
          // A conflict means another tab holds a newer workspace. Saving stays
          // off so this tab cannot overwrite it — and that has to be visible,
          // because from here on nothing typed is being kept.
          if (response.status === 409) {
            restoreFailed.current = true;
            setRestoreError(true);
          }
          throw Error(data.error || 'Cloud sync unavailable');
        }
        cloudRevision.current = data.revision;
        savedRevision.current = at;
        if (!disposed) setStorageMessage('Saved to your workspace');
      } catch (e) {
        if (!disposed)
          setStorageMessage(
            (e instanceof Error ? e.message : 'Cloud sync unavailable') +
              '. Export your session to keep your work.',
          );
      } finally {
        saving = false;
      }
    };
    void save();
    const timer = setInterval(() => void save(), 1500);
    const hidden = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [loaded]);
  return (
    <Context.Provider
      value={{
        prepareRunConnections,
        sharedKnowledge,
        refreshSharedKnowledge,
        connectorStatus,
        knowledge,
        setKnowledge,
        workspaceLoaded: loaded,
        workspace,
        setWorkspace,
        mediaKey,
        setMediaKey,
        connectorKeys,
        setConnectorKeys,
        connectorTools,
        connectConnector,
        model,
        additions,
        experimental,
        applyRows,
        provider,
        setProvider,
        conversations,
        setConversations,
        files,
        setFiles,
        session,
        importSession: (t) => {
          restore(parseSession(t));
          restoreFailed.current = false;
          setRestoreError(false);
          revision.current++;
        },
        storageMessage,
        restoreFailed: restoreError,
        openSettings: onSettings,
        preferences,
        setPreferences,
        activeId,
        setActiveId,
        mode,
        setMode,
        models,
        setModels,
        modelsLoading,
        modelsError,
        modelsLoadedAt,
        refreshModels,
        runSettingsOpen,
        setRunSettingsOpen,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function usePlayground() {
  const c = useContext(Context);
  if (!c) throw Error('Missing workspace context');
  return c;
}
