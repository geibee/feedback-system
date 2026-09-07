import type { JiraCloudFetch } from "@geibee/feedback-connector-jira-cloud";
import type { RedmineFetch } from "@geibee/feedback-connector-redmine";

export const nodeJiraCloudFetch: JiraCloudFetch = async (input, init) => {
  const response = await fetch(input, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body as never }),
    ...(init.signal ? { signal: init.signal as AbortSignal } : {}),
    ...(init.duplex ? { duplex: init.duplex } : {}),
    ...(init.redirect ? { redirect: init.redirect } : {})
  });
  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
    text: () => response.text(),
    body: response.body ? readableStream(response.body) : null
  };
};

export const nodeRedmineFetch: RedmineFetch = async (input, init) => {
  const controller = new AbortController();
  if (init.signal?.aborted) controller.abort();
  const unsubscribe = init.signal?.subscribe(() => controller.abort());
  try {
    const response = await fetch(input, {
      method: init.method,
      headers: { ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body as never }),
      signal: controller.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      json: () => response.json(),
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer()
    };
  } finally {
    unsubscribe?.();
  }
};

export const nodeBacklogFetch: BacklogFetch = async (input, init) => {
  const response = await fetch(input, {
    method: init.method,
    headers: { ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.signal ? { signal: init.signal as AbortSignal } : {}),
    ...(init.redirect ? { redirect: init.redirect } : {})
  });
  return { status: response.status, headers: response.headers, text: () => response.text() };
};

async function* readableStream(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}
import type { BacklogFetch } from "@geibee/feedback-connector-backlog";
