import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { User } from "@supabase/supabase-js";
import { ChevronDown, KeyRound, ListRestart, Loader2, RefreshCw, Trash2 } from "lucide-react";
import {
  addApiKey,
  listApiKeys,
  refreshApiKeyModels,
  removeApiKey,
  testApiKey,
  testApiKeyModel,
} from "@/lib/hai/hai.functions";
import { readStoredModels } from "@/lib/hai/discovery";
import { PROVIDERS, getProvider, type ProviderId } from "@/lib/hai/providers";
import { GoogleSignInButton } from "@/components/cosmic/GoogleSignInButton";

const STATUS_LABEL: Record<string, string> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  untested: "Not tested",
};

interface ApiManagerProps {
  user: User | null;
  onSignIn: () => void;
  onUseModel: (modelId: string, provider: ProviderId, keyId: string) => void;
}

export function ApiManager({ user, onSignIn, onUseModel }: ApiManagerProps) {
  if (!user) {
    return (
      <div className="api-manager">
        <p className="side-menu__note api-manager__intro">
          Sign in with Google to manage your encrypted provider keys.
        </p>
        <GoogleSignInButton onClick={onSignIn} />
      </div>
    );
  }
  return <ApiManagerPanel userId={user.id} onUseModel={onUseModel} />;
}

function ApiManagerPanel({
  userId,
  onUseModel,
}: {
  userId: string;
  onUseModel: (modelId: string, provider: ProviderId, keyId: string) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["hai-keys", userId] as const;
  const list = useServerFn(listApiKeys);
  const add = useServerFn(addApiKey);
  const test = useServerFn(testApiKey);
  const testModel = useServerFn(testApiKeyModel);
  const remove = useServerFn(removeApiKey);
  const refreshModels = useServerFn(refreshApiKeyModels);

  const [provider, setProvider] = useState<ProviderId>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");
  const [formError, setFormError] = useState("");

  const keys = useQuery({ queryKey, queryFn: () => list() });
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const addMutation = useMutation({
    mutationFn: () =>
      add({
        data: {
          provider,
          apiKey,
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(provider === "custom" ? { baseUrl: baseUrl.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setApiKey("");
      setLabel("");
      setFormError("");
      void refresh();
    },
    onError: (error) => setFormError(readError(error)),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => test({ data: { id } }),
    onSettled: refresh,
  });
  const modelMutation = useMutation({
    mutationFn: (vars: { id: string; model: string }) => testModel({ data: vars }),
    onSettled: refresh,
  });
  const refreshMutation = useMutation({
    mutationFn: (id: string) => refreshModels({ data: { id } }),
    onSettled: refresh,
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSettled: refresh,
  });

  const changeProvider = (next: ProviderId) => {
    setProvider(next);
    setFormError("");
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (apiKey.trim()) addMutation.mutate();
  };

  const keyRows = keys.data ?? [];
  const modelGroups = new Map<
    string,
    Array<{ key: (typeof keyRows)[number]; model: ReturnType<typeof readStoredModels>[number] }>
  >();
  for (const key of keyRows) {
    for (const model of readStoredModels(key.models)) {
      const identity = `${key.provider}:${model.id}`;
      const group = modelGroups.get(identity) ?? [];
      group.push({ key, model });
      modelGroups.set(identity, group);
    }
  }
  const models = [...modelGroups.values()].map((entries) => {
    entries.sort((a, b) => {
      const usable =
        Number(b.key.status !== "unhealthy" && b.model.health === "available") -
        Number(a.key.status !== "unhealthy" && a.model.health === "available");
      const health =
        Number(b.model.health === "available") - Number(a.model.health === "available");
      return (
        usable || health || Number(b.key.status === "healthy") - Number(a.key.status === "healthy")
      );
    });
    return entries[0]!;
  });
  const availableModels = models.filter(
    ({ key, model }) => key.status !== "unhealthy" && model.health === "available",
  );
  const unavailableModels = models.filter(
    ({ key, model }) => key.status === "unhealthy" || model.health !== "available",
  );
  const healthyKeys = keyRows.filter((key) => key.status === "healthy");
  const unhealthyKeys = keyRows.filter((key) => key.status !== "healthy");

  const renderKey = (key: (typeof keyRows)[number], unhealthy: boolean) => {
    const name = key.label || getProvider(key.provider as ProviderId).label;
    const busy = testMutation.isPending && testMutation.variables === key.id;
    const removing = removeMutation.isPending && removeMutation.variables === key.id;
    return (
      <li key={key.id} className="api-key">
        <div className="api-key__top">
          <span className={`api-status api-status--${key.status}`}>
            <span aria-hidden="true" />
            {STATUS_LABEL[key.status] ?? key.status}
          </span>
          <div className="api-key__actions">
            <button
              type="button"
              onClick={() => testMutation.mutate(key.id)}
              disabled={busy || removing}
            >
              <RefreshCw aria-hidden="true" className={busy ? "api-spin" : undefined} />
              {unhealthy ? "Retest" : "Test"}
            </button>
            <button type="button" onClick={() => removeMutation.mutate(key.id)} disabled={removing}>
              <Trash2 aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
        <strong>{name}</strong>
        <small>{getProvider(key.provider as ProviderId).label}</small>
        {unhealthy && key.last_error && <small className="api-key__error">{key.last_error}</small>}
        {!unhealthy && key.models_error && (
          <small className="api-key__error">{key.models_error}</small>
        )}
        {testMutation.isError && testMutation.variables === key.id && (
          <small className="api-key__error">{readError(testMutation.error)}</small>
        )}
      </li>
    );
  };

  const renderModel = (entry: (typeof models)[number], unavailable: boolean) => {
    const { key, model } = entry;
    const providerInfo = getProvider(key.provider as ProviderId);
    const labelText = key.label || providerInfo.label;
    const isTesting =
      modelMutation.isPending &&
      modelMutation.variables?.id === key.id &&
      modelMutation.variables.model === model.id;
    const isRefreshing = refreshMutation.isPending && refreshMutation.variables === key.id;
    return (
      <li className="api-key api-model" key={`${key.provider}:${model.id}`}>
        <div className="api-key__top">
          <span
            className={`api-status api-status--${model.health === "available" ? "healthy" : "unhealthy"}`}
          >
            <span aria-hidden="true" />
            Model {model.health} · key {STATUS_LABEL[key.status] ?? key.status}
          </span>
          <div className="api-key__actions">
            {!unavailable && (
              <button
                type="button"
                onClick={() => onUseModel(model.id, key.provider as ProviderId, key.id)}
              >
                Use Model
              </button>
            )}
            <button
              type="button"
              onClick={() => modelMutation.mutate({ id: key.id, model: model.id })}
              disabled={isTesting || isRefreshing}
            >
              <RefreshCw aria-hidden="true" className={isTesting ? "api-spin" : undefined} />
              {unavailable ? "Retry" : "Test Model"}
            </button>
            {unavailable && (
              <button
                type="button"
                onClick={() => refreshMutation.mutate(key.id)}
                disabled={isRefreshing || isTesting}
              >
                <ListRestart aria-hidden="true" className={isRefreshing ? "api-spin" : undefined} />
                Refresh Models
              </button>
            )}
          </div>
        </div>
        <strong>{model.name}</strong>
        <small className="api-model__id">{model.id}</small>
        <small>
          {providerInfo.label} · {labelText} · key {STATUS_LABEL[key.status] ?? key.status}
        </small>
        {(model.error || key.last_error || key.models_error) && (
          <small className="api-key__error">
            {model.error || key.last_error || key.models_error}
          </small>
        )}
        {modelMutation.isError &&
          modelMutation.variables?.id === key.id &&
          modelMutation.variables.model === model.id && (
            <small className="api-key__error">{readError(modelMutation.error)}</small>
          )}
        {refreshMutation.isError && refreshMutation.variables === key.id && (
          <small className="api-key__error">{readError(refreshMutation.error)}</small>
        )}
      </li>
    );
  };

  return (
    <div className="api-manager">
      <form className="api-form" onSubmit={submit}>
        <label className="api-field">
          <span>Provider</span>
          <select
            value={provider}
            onChange={(event) => changeProvider(event.target.value as ProviderId)}
          >
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        {provider === "custom" && (
          <label className="api-field">
            <span>Endpoint (https)</span>
            <input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              inputMode="url"
            />
          </label>
        )}
        <label className="api-field">
          <span>API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Paste your key"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="api-field">
          <span>Label (optional)</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="e.g. Work key"
            maxLength={40}
          />
        </label>
        {formError && (
          <p className="api-error" role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          className="new-chat-button api-form__submit"
          disabled={addMutation.isPending || !apiKey.trim()}
        >
          {addMutation.isPending ? (
            <Loader2 className="api-spin" aria-hidden="true" />
          ) : (
            <KeyRound aria-hidden="true" />
          )}
          {addMutation.isPending ? "Checking key & testing models…" : "Save"}
        </button>
      </form>

      {keys.isLoading && <p className="side-menu__note">Loading keys…</p>}
      {keys.isError && <p className="api-error">Could not load your keys.</p>}

      <ManagerSection title="Healthy API Keys" count={healthyKeys.length} collapsible defaultOpen>
        {healthyKeys.length ? (
          <ul className="api-key-list">{healthyKeys.map((key) => renderKey(key, false))}</ul>
        ) : (
          <p className="side-menu__note">No healthy keys.</p>
        )}
      </ManagerSection>
      <ManagerSection title="Unhealthy API Keys" count={unhealthyKeys.length} collapsible>
        {unhealthyKeys.length ? (
          <ul className="api-key-list">{unhealthyKeys.map((key) => renderKey(key, true))}</ul>
        ) : (
          <p className="side-menu__note">No unhealthy keys.</p>
        )}
      </ManagerSection>
      <ManagerSection title="Available Models" count={availableModels.length} collapsible defaultOpen>
        {availableModels.length ? (
          <ul className="api-key-list">
            {availableModels.map((entry) => renderModel(entry, false))}
          </ul>
        ) : (
          <p className="side-menu__note">Models appear here after a saved key is validated.</p>
        )}
      </ManagerSection>
      <ManagerSection
        title="Unavailable / Unhealthy Models"
        count={unavailableModels.length}
        collapsible
      >
        {unavailableModels.length ? (
          <ul className="api-key-list">
            {unavailableModels.map((entry) => renderModel(entry, true))}
          </ul>
        ) : (
          <p className="side-menu__note">No unavailable models.</p>
        )}
      </ManagerSection>
    </div>
  );
}

function ManagerSection({
  title,
  count,
  collapsible = false,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  /** Hidden until opened, for lists people rarely need to look at. */
  collapsible?: boolean;
  /** Collapsible lists people use often start open. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  if (!collapsible) {
    return (
      <section className="api-manager__section">
        <div className="side-menu__section-title api-manager__count">
          <span>{title}</span>
          <small>{count}</small>
        </div>
        {children}
      </section>
    );
  }
  return (
    <section className="api-manager__section">
      <button
        type="button"
        className="side-menu__section-title api-manager__count api-manager__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{title}</span>
        <span className="api-manager__toggle-end">
          <small>{count}</small>
          <em>{open ? "Hide" : "Show"}</em>
          <ChevronDown aria-hidden="true" className={open ? "is-open" : undefined} />
        </span>
      </button>
      {open && children}
    </section>
  );
}

function readError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as unknown;
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
        const message = (parsed[0] as Record<string, unknown>)["message"];
        if (typeof message === "string") return message;
      }
    } catch {
      // plain message
    }
    return error.message;
  }
  return "Something went wrong.";
}
