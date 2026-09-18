// Provider preset registry — embedded OmniRoute for Orin Code.
// One OpenAI-compatible streaming engine serves every provider below; each
// preset carries its endpoint, key policy, docs link, and list strategy.
// Model ids are namespaced `<preset>/<model>` and dispatch on the first segment.
// Users only paste an API key — base URLs and headers are built in.

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub base_url: &'static str,
    pub key_required: bool,
    /// How to list models: "openai" (GET {base}/models),
    /// "ollama" (GET {base}/../api/tags), or "curated" (no HTTP list endpoint).
    pub list_kind: &'static str,
    /// Where the user gets an API key (shown in Settings → Models).
    pub docs_url: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", key_required: true, list_kind: "openai", docs_url: "https://openrouter.ai/settings/keys" },
    Preset { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", key_required: true, list_kind: "openai", docs_url: "https://console.groq.com/keys" },
    Preset { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", key_required: true, list_kind: "openai", docs_url: "https://platform.deepseek.com/api_keys" },
    Preset { id: "mistral", label: "Mistral", base_url: "https://api.mistral.ai/v1", key_required: true, list_kind: "openai", docs_url: "https://console.mistral.ai/api-keys" },
    Preset { id: "together", label: "Together", base_url: "https://api.together.xyz/v1", key_required: true, list_kind: "openai", docs_url: "https://api.together.xyz/settings/api-keys" },
    Preset { id: "fireworks", label: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", key_required: true, list_kind: "openai", docs_url: "https://fireworks.ai/account/api-keys" },
    Preset { id: "xai", label: "xAI (Grok)", base_url: "https://api.x.ai/v1", key_required: true, list_kind: "openai", docs_url: "https://console.x.ai" },
    Preset { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", key_required: true, list_kind: "openai", docs_url: "https://platform.openai.com/api-keys" },
    Preset { id: "anthropic", label: "Anthropic", base_url: "https://api.anthropic.com/v1", key_required: true, list_kind: "curated", docs_url: "https://console.anthropic.com/settings/keys" },
    Preset { id: "gemini", label: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", key_required: true, list_kind: "openai", docs_url: "https://aistudio.google.com/apikey" },
    Preset { id: "cohere", label: "Cohere", base_url: "https://api.cohere.ai/compatibility/v1", key_required: true, list_kind: "openai", docs_url: "https://dashboard.cohere.com/api-keys" },
    Preset { id: "perplexity", label: "Perplexity", base_url: "https://api.perplexity.ai", key_required: true, list_kind: "openai", docs_url: "https://www.perplexity.ai/settings/api" },
    Preset { id: "ollama", label: "Ollama (local)", base_url: "http://localhost:11434/v1", key_required: false, list_kind: "ollama", docs_url: "https://ollama.com" },
    Preset { id: "lmstudio", label: "LM Studio (local)", base_url: "http://localhost:1234/v1", key_required: false, list_kind: "openai", docs_url: "https://lmstudio.ai/docs/app/api/endpoints/openai" },
    Preset { id: "vllm", label: "vLLM (local)", base_url: "http://localhost:8000/v1", key_required: false, list_kind: "openai", docs_url: "https://docs.vllm.ai/en/latest/getting_started/quickstart.html" },
    Preset { id: "litellm", label: "LiteLLM proxy", base_url: "http://localhost:4000/v1", key_required: false, list_kind: "openai", docs_url: "https://docs.litellm.ai/docs/providers/openai_compatible" },
    Preset { id: "custom", label: "Custom (OpenAI-compatible)", base_url: "", key_required: false, list_kind: "openai", docs_url: "" },
];

pub fn find(preset_id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|preset| preset.id == preset_id)
}

/// Which keyring slot stores this preset's API key. The legacy generic slot
/// "openai_compat" is kept for backward compatibility.
pub fn keyring_user(preset_id: &str) -> String {
    if preset_id == "openai_compat" || preset_id == "openai" {
        "openai_compat".to_string()
    } else {
        preset_id.to_string()
    }
}

/// Resolve the base URL for a preset: per-preset KV override → legacy
/// generic override (for openai_compat/custom) → preset default.
/// Per-preset overrides live at `providers/{id}/baseUrl` so users can
/// self-host without losing the built-in headers.
pub fn resolve_base_url(preset_id: &str, custom: &Option<String>) -> String {
    if let Some(custom_url) = custom {
        if !custom_url.trim().is_empty() && (preset_id == "openai_compat" || preset_id == "custom") {
            return custom_url.trim().trim_end_matches('/').to_string();
        }
    }
    find(preset_id)
        .map(|preset| preset.base_url.to_string())
        .unwrap_or_else(|| "https://openrouter.ai/api/v1".to_string())
}

/// Built-in request headers per provider so users never hand-write them.
/// OpenRouter asks for HTTP-Referer + X-Title; harmless elsewhere so the
/// single streaming engine can attach them unconditionally per preset.
pub fn preset_headers(preset_id: &str) -> Vec<(&'static str, String)> {
    match preset_id {
        "openrouter" => vec![
            ("HTTP-Referer", "https://orin.ai".to_string()),
            ("X-Title", "Orin Code".to_string()),
        ],
        _ => vec![],
    }
}

pub fn is_openai_compatible(preset_id: &str) -> bool {
    preset_id != "anthropic" && preset_id != "mock"
}
