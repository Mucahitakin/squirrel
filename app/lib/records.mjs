// Squirrel — kayıt okuma/özetleme.
// results.jsonl satırlarını UI'nin beklediği hafif (lite) ve detay biçimlere çevirir.
import fs from 'node:fs';

export function* readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* yarım satır */ }
  }
}

// raw_events içinden token sayaçlarını toplar (input/prompt + output/completion).
export function tokensFromPayload(node, acc, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const k = key.toLowerCase();
      if (k === 'input_tokens' || k === 'prompt_tokens') acc.in += value;
      else if (k === 'output_tokens' || k === 'completion_tokens') acc.out += value;
    } else if (value && typeof value === 'object') tokensFromPayload(value, acc, depth + 1);
  }
}

// Tablo görünümleri için hafif kayıt (ham event'ler hariç).
export function liteRecord(record) {
  return {
    index: record.index,
    category: record.category,
    logical_thread: record.logical_thread,
    thread_id: record.thread_id,
    run_id: record.run_id,
    user: record.message,
    status: record.status,
    completion_status: record.completion_status,
    terminal_reason: record.terminal_reason,
    duration_s: record.duration_ms == null ? null : Math.round(record.duration_ms / 1000),
    agent_text: record.assistant_text,
    tools: (record.tools || []).map((tool) => ({
      capability: tool.capability, status: tool.status,
      ...(Number(tool.duration_ms) > 0 ? { duration_ms: Number(tool.duration_ms) } : {}),
    })),
    error_codes: (record.errors || []).map((error) => error?.payload?.code || error?.type).filter(Boolean),
    artifacts: (record.artifacts || []).map((artifact) => ({
      type: artifact.type || null, title: artifact.title || null, urls: artifact.urls || [],
    })),
    attachments_sent: record.attachments_sent || [],
    expectation_status: record.expectation_status || 'none',
    tags: Array.isArray(record.tags) ? record.tags : [],
    metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : null,
    scores: Array.isArray(record.scores) ? record.scores : [],
    started_at: record.started_at || null,
  };
}

// Detay görünümü: ham event'ler kırpılarak verilir (UI donmasın).
export function detailRecord(record) {
  const events = (record.raw_events || []).slice(0, 400).map((event, position) => {
    const payloadText = JSON.stringify(event.payload ?? {});
    return {
      n: event.sequence ?? position,
      type: event.type || '?',
      at: event.created_at || event.at || null,
      payload: payloadText.length > 3000 ? `${payloadText.slice(0, 3000)}…(kırpıldı)` : payloadText,
    };
  });
  return {
    ...liteRecord(record),
    errors: (record.errors || []).map((error) => ({
      type: error.type,
      code: error?.payload?.code || null,
      message: String(error?.payload?.message || '').slice(0, 600),
    })),
    event_type_counts: record.event_type_counts || {},
    events,
    started_at: record.started_at,
    finished_at: record.finished_at,
  };
}
