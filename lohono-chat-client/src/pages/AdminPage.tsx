import { useState, useEffect, useCallback } from "react";
import { admin, type AclToolConfig, type AclGlobalConfig } from "../api";
import AclAutocomplete from "../components/AclAutocomplete";

function ToolMultiSelect({
  availableTools,
  selectedTools,
  onChange,
  placeholder,
}: {
  availableTools: string[];
  selectedTools: string[];
  onChange: (tools: string[]) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filtered = availableTools.filter(
    (t) => !selectedTools.includes(t) && t.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1.5 mb-2">
        {selectedTools.map((tool) => (
          <span
            key={tool}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-200 text-gray-700 text-xs font-medium rounded-full border border-gray-300"
          >
            {tool}
            <button
              onClick={() => onChange(selectedTools.filter((t) => t !== tool))}
              className="hover:text-red-400 transition-colors ml-0.5"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setIsOpen(true); }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setTimeout(() => setIsOpen(false), 150)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-secondary/20 rounded-lg bg-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
      />
      {isOpen && filtered.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-secondary/20 rounded-lg shadow-lg">
          {filtered.map((tool) => (
            <button
              key={tool}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange([...selectedTools, tool]); setQuery(""); }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 transition-colors"
            >
              {tool}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [toolAcls, setToolAcls] = useState<AclToolConfig[]>([]);
  const [globalConfig, setGlobalConfig] = useState<AclGlobalConfig | null>(null);
  const [availableAcls, setAvailableAcls] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [showAddTool, setShowAddTool] = useState(false);
  const [addToolQuery, setAddToolQuery] = useState("");

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [configs, global, acls, tools] = await Promise.all([
        admin.listToolAcls(),
        admin.getGlobalConfig(),
        admin.getAvailableAcls(),
        admin.getAvailableTools(),
      ]);
      setToolAcls(configs);
      setGlobalConfig(global);
      setAvailableAcls(acls);
      setAvailableTools(tools);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  // ── Global config handlers ──

  const handleGlobalUpdate = async (
    field: keyof Pick<AclGlobalConfig, "default_policy" | "public_tools" | "disabled_tools">,
    value: unknown
  ) => {
    setSaving("global");
    try {
      const updated = await admin.updateGlobalConfig({ [field]: value });
      setGlobalConfig(updated);
      showSuccess(`Updated ${field.replace(/_/g, " ")}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  // ── Tool ACL handlers ──

  const handleAclChange = async (toolName: string, acls: string[]) => {
    setSaving(toolName);
    try {
      await admin.upsertToolAcl(toolName, acls);
      setToolAcls((prev) =>
        prev.map((t) =>
          t.toolName === toolName ? { ...t, acls, updatedAt: new Date().toISOString() } : t
        )
      );
      showSuccess(`Updated ACLs for ${toolName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (toolName: string) => {
    setSaving(toolName);
    try {
      await admin.deleteToolAcl(toolName);
      setToolAcls((prev) => prev.filter((t) => t.toolName !== toolName));
      showSuccess(`Removed ACL config for ${toolName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSaving(null);
    }
  };

  const handleAddTool = async (toolName: string) => {
    setSaving(toolName);
    try {
      const config = await admin.upsertToolAcl(toolName, []);
      setToolAcls((prev) => [...prev, config].sort((a, b) => a.toolName.localeCompare(b.toolName)));
      setShowAddTool(false);
      setAddToolQuery("");
      showSuccess(`Added ${toolName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add tool");
    } finally {
      setSaving(null);
    }
  };

  const configuredTools = new Set(toolAcls.map((t) => t.toolName));
  const unconfiguredTools = availableTools.filter(
    (t) =>
      !configuredTools.has(t) &&
      t.toLowerCase().includes(addToolQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-primary">ACL Management</h1>
          <p className="text-sm text-text/60 mt-1">
            Manage access control for tools. Users need at least one of the assigned ACLs to access a tool.
          </p>
        </div>

        {/* Status messages */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
            {error}
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {successMsg && (
          <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {successMsg}
          </div>
        )}

        {/* ── Global Settings ── */}
        {globalConfig && (
          <div className="mb-8 bg-white border border-secondary/15 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-5">
              <h2 className="text-lg font-semibold text-primary">Global Settings</h2>
              {saving === "global" && (
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              )}
            </div>

            <div className="space-y-5">
              {/* Default Policy */}
              <div>
                <label className="block text-sm font-medium text-text/70 mb-1.5">Default Policy</label>
                <p className="text-xs text-text/50 mb-2">
                  What happens when a tool has no ACL config: "open" allows any authenticated user, "deny" blocks access.
                </p>
                <div className="flex gap-2">
                  {(["open", "deny"] as const).map((policy) => (
                    <button
                      key={policy}
                      onClick={() => handleGlobalUpdate("default_policy", policy)}
                      className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                        globalConfig.default_policy === policy
                          ? "bg-primary text-white border-primary"
                          : "bg-white text-text/60 border-secondary/20 hover:border-accent"
                      }`}
                    >
                      {policy}
                    </button>
                  ))}
                </div>
              </div>

              {/* Public Tools */}
              <div>
                <label className="block text-sm font-medium text-text/70 mb-1.5">Public Tools</label>
                <p className="text-xs text-text/50 mb-2">
                  Tools that require no authentication. Overridden if the tool also has per-tool ACLs configured below.
                </p>
                <ToolMultiSelect
                  availableTools={availableTools}
                  selectedTools={globalConfig.public_tools}
                  onChange={(tools) => handleGlobalUpdate("public_tools", tools)}
                  placeholder="Search and add public tools..."
                />
              </div>

              {/* Disabled Tools */}
              <div>
                <label className="block text-sm font-medium text-text/70 mb-1.5">Disabled Tools</label>
                <p className="text-xs text-text/50 mb-2">
                  Tools that are completely blocked for everyone.
                </p>
                <ToolMultiSelect
                  availableTools={availableTools}
                  selectedTools={globalConfig.disabled_tools}
                  onChange={(tools) => handleGlobalUpdate("disabled_tools", tools)}
                  placeholder="Search and add disabled tools..."
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Per-Tool ACLs ── */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-primary">Per-Tool ACLs</h2>
        </div>

        {/* Add tool button */}
        <div className="mb-6">
          {!showAddTool ? (
            <button
              onClick={() => setShowAddTool(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Tool
            </button>
          ) : (
            <div className="bg-white border border-secondary/20 rounded-lg p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-sm font-medium text-primary">Select a tool to configure</h3>
                <button
                  onClick={() => { setShowAddTool(false); setAddToolQuery(""); }}
                  className="ml-auto text-text/40 hover:text-text/60"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <input
                type="text"
                value={addToolQuery}
                onChange={(e) => setAddToolQuery(e.target.value)}
                placeholder="Search tools..."
                className="w-full px-3 py-2 text-sm border border-secondary/20 rounded-lg bg-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 mb-2"
                autoFocus
              />
              <div className="max-h-48 overflow-y-auto">
                {unconfiguredTools.length === 0 ? (
                  <p className="text-sm text-text/40 py-2">
                    {addToolQuery ? "No matching tools" : "All tools are already configured"}
                  </p>
                ) : (
                  unconfiguredTools.map((tool) => (
                    <button
                      key={tool}
                      onClick={() => handleAddTool(tool)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-accent/10 rounded transition-colors"
                    >
                      {tool}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tool ACL table */}
        <div className="space-y-3">
          {toolAcls.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-text/40 text-sm">No tool ACL configurations yet. Click "Add Tool" to get started.</p>
            </div>
          ) : (
            toolAcls.map((config) => (
              <div
                key={config.toolName}
                className="bg-white border border-secondary/15 rounded-xl p-5 shadow-sm"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-mono text-sm font-semibold text-primary">
                      {config.toolName}
                    </h3>
                    <p className="text-xs text-text/40 mt-0.5">
                      Last updated: {new Date(config.updatedAt).toLocaleString()}
                      {config.updatedBy && ` by ${config.updatedBy}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {saving === config.toolName && (
                      <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                    )}
                    <button
                      onClick={() => handleDelete(config.toolName)}
                      className="p-1.5 text-text/30 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50"
                      title="Remove tool ACL config"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
                <AclAutocomplete
                  availableAcls={availableAcls}
                  selectedAcls={config.acls}
                  onChange={(acls) => handleAclChange(config.toolName, acls)}
                />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
