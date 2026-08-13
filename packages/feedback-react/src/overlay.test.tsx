import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryFeedbackTelemetry, type FeedbackHostAdapter, type FeedbackTransport } from "@feedback/core";
import { FeedbackOverlay, createLocalStorageParticipantAdapter, feedbackThreadMatchesLocation } from "./overlay";
import { FeedbackProvider } from "./index";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1",
  manifestVersion: "1",
  title: "テストレビュー",
  description: null,
  status: "open" as const,
  outOfScopePosting: "warn" as const,
  startAt: null,
  endAt: null,
  scopes: [{ pageKey: "orders.detail", routeTemplate: "/orders/{id}", reviewable: true }],
  perspectives: [{ code: "usability", label: "使いやすさ", status: "active" as const, guidance: null }],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const thread = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: session.id,
  displayNumber: 1,
  location: {
    schemaVersion: "1" as const,
    pageKey: "orders.detail",
    routeTemplate: "/orders/{id}",
    pathParameters: { id: "O-1" }
  },
  target: { schemaVersion: "1" as const, kind: "screen-position" as const, relativeX: 0.5, relativeY: 0.5 },
  perspectiveCode: "usability",
  status: "open" as const,
  reporter: { principalId: "user-1", displayName: "利用者", participantName: null },
  evidenceAvailable: false,
  messages: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FeedbackOverlay", () => {
  it("別locationの同じDOM keyへpinを混在させない", () => {
    expect(feedbackThreadMatchesLocation(thread, {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-1" }
    })).toBe(true);
    expect(feedbackThreadMatchesLocation(thread, {
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-2" }
    })).toBe(false);
  });

  it("capture失敗時もコメントだけを投稿する", async () => {
    const posted: unknown[] = [];
    const adapter = createAdapter({ captureEvidence: vi.fn(async () => { throw new Error("capture blocked"); }) });
    const telemetry = createInMemoryFeedbackTelemetry();
    const transport = createTransport(async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        posted.push(options.body);
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={adapter} transport={transport} telemetry={telemetry}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    fireEvent.click(document.body, { clientX: 320, clientY: 240 });
    fireEvent.change(await screen.findByLabelText("コメント"), { target: { value: "確認してください" } });
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ body: "確認してください" });
    expect(posted[0]).not.toHaveProperty("evidence");
    expect(telemetry.snapshot()).toMatchObject({ capture_failure: 1, post_success: 1 });
  });

  it("不確実な送信失敗の再試行で同じIdempotency-Keyとbodyを再利用する", async () => {
    const attempts: Array<{ key?: string; body?: unknown }> = [];
    const transport = createTransport(async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        attempts.push({ key: options.idempotencyKey, body: options.body });
        if (attempts.length === 1) throw new Error("response lost");
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport} features={{ evidenceCapture: false }}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    fireEvent.click(document.body, { clientX: 320, clientY: 240 });
    fireEvent.change(await screen.findByLabelText("コメント"), { target: { value: "再試行" } });
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(attempts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "投稿する" }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("deep link navigation完了後にthread drawerを開く", async () => {
    let finishNavigation: (() => void) | undefined;
    const navigate = vi.fn(() => new Promise<void>((resolve) => { finishNavigation = resolve; }));
    const adapter = createAdapter({ navigate });
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={adapter} transport={transport}>
        <FeedbackOverlay deepLinkThreadId={thread.id} />
      </FeedbackProvider>
    );

    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(screen.queryByRole("heading", { name: /#1/ })).toBeNull();
    finishNavigation?.();
    expect(await screen.findByRole("heading", { name: /#1/ })).toBeTruthy();
  });

  it("localStorageを利用できなくてもidentity adapterは失敗しない", () => {
    const storage = {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
      removeItem: () => { throw new Error("disabled"); }
    };
    const adapter = createLocalStorageParticipantAdapter(storage);
    expect(adapter.getParticipantName()).toBeNull();
    expect(() => adapter.setParticipantName("利用者")).not.toThrow();
  });

  it("posting denyでは投稿導線を閉じ、既存threadの閲覧を維持する", async () => {
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      throw new Error(`unexpected: ${path}`);
    }, { posting: "deny" });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    expect((await screen.findByRole("status")).textContent).toContain("投稿できません");
    expect(screen.queryByRole("button", { name: "フィードバック" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /#1/ }));
    expect(await screen.findByRole("heading", { name: /#1/ })).toBeTruthy();
  });

  it.each([
    ["authenticated-identity", false],
    ["prompt", true],
    ["authenticated-and-prompt", true]
  ] as const)("participant policy %s のpromptを適用する", async (mode, expected) => {
    const participantPolicy = mode === "authenticated-identity"
      ? { mode }
      : { mode, storage: "memory" as const };
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    }, { participantPolicy });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    fireEvent.click(document.body, { clientX: 320, clientY: 240 });
    await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(screen.queryByRole("textbox", { name: /投稿者名/ }) !== null).toBe(expected);
  });

  it("対象選択時に証跡を取得し、投稿者名と画面に割り当てたレビュー観点を投稿する", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const captureEvidence = vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png" as const,
      viewportWidth: 1280,
      viewportHeight: 720,
      pixelRatio: 1,
      capturedAt: "2026-08-13T00:00:00Z"
    }));
    const assignedSession = {
      ...session,
      perspectives: [
        ...session.perspectives,
        { code: "future", label: "将来確認", status: "future" as const, guidance: "次回確認します" }
      ],
      scopes: [{ ...session.scopes[0], perspectiveCodes: ["usability"] }]
    };
    const transport = createTransport(async (path, options) => {
      if (path.endsWith("/threads") && options?.method === "POST") {
        posted.push(options.body as Record<string, unknown>);
        return { value: thread, etag: '"1"' };
      }
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    }, {
      session: assignedSession,
      participantPolicy: { mode: "prompt", storage: "host" }
    });
    const adapter = createAdapter({
      captureEvidence,
      getParticipantName: () => "山田 太郎",
      setParticipantName: vi.fn()
    });
    render(
      <FeedbackProvider adapter={adapter} transport={transport}>
        <button type="button" data-feedback-key="orders.save">保存</button>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "フィードバック" }));
    const target = screen.getByRole("button", { name: "保存" });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40,
      toJSON: () => ({})
    });
    fireEvent.click(target, { clientX: 200, clientY: 120 });

    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ kind: "ui-element", elementKey: "orders.save", relativeX: .5, relativeY: .5 })
    }));
    expect(within(composer).getByText(/1280×720/)).toBeTruthy();
    expect(within(composer).getByRole("radio", { name: /使いやすさ/ })).toBeTruthy();
    expect(within(composer).queryByRole("radio", { name: /将来確認/ })).toBeNull();
    expect((within(composer).getByRole("textbox", { name: /投稿者名/ }) as HTMLInputElement).value).toBe("山田 太郎");
    fireEvent.change(within(composer).getByRole("textbox", { name: "コメント" }), {
      target: { value: "保存動作を確認してください" }
    });
    fireEvent.click(within(composer).getByRole("button", { name: "投稿する" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      perspectiveCode: "usability",
      participantName: "山田 太郎",
      body: "保存動作を確認してください",
      target: { kind: "ui-element", elementKey: "orders.save" },
      evidence: { contentType: "image/png", dataBase64: "AQID" }
    });
  });

  it("右クリックメニューから対象を保持して投稿画面を開く", async () => {
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport} features={{ contextMenu: true, evidenceCapture: false }}>
        <button type="button" data-feedback-key="orders.save">保存</button>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    const target = await screen.findByRole("button", { name: "保存" });
    const contextMenuEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 160, clientY: 120 });
    fireEvent(target, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    const menu = screen.getByRole("menu", { name: "フィードバックメニュー" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "フィードバックを残す" }));
    const composer = await screen.findByRole("dialog", { name: "フィードバックの投稿" });
    expect(within(composer).getByText("orders.save")).toBeTruthy();
  });

  it("data-feedback-map領域の右クリックを無視せずhost resolverまたは画面座標へ変換する", async () => {
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    const targetResolver = vi.fn(() => ({
      schemaVersion: "1" as const,
      kind: "map-position" as const,
      longitude: 139.7,
      latitude: 35.6
    }));
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport} features={{ contextMenu: true, evidenceCapture: false }}>
        <div data-feedback-map=""><canvas aria-label="地図" /></div>
        <FeedbackOverlay targetResolver={targetResolver} />
      </FeedbackProvider>
    );

    const mapCanvas = await screen.findByLabelText("地図");
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 160,
      clientY: 120
    });
    fireEvent(mapCanvas, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(targetResolver).toHaveBeenCalledWith(expect.objectContaining({
      action: "context-menu",
      element: mapCanvas,
      clientX: 160,
      clientY: 120
    }));
    fireEvent.click(screen.getByRole("menuitem", { name: "フィードバックを残す" }));
    expect(await screen.findByRole("dialog", { name: "フィードバックの投稿" })).toBeTruthy();
  });

  it("他の人の投稿を画面ごとに一覧表示し、選択したスレッドへ遷移する", async () => {
    const navigate = vi.fn();
    const otherThread = {
      ...thread,
      location: {
        ...thread.location,
        pageKey: "orders.list",
        routeTemplate: "/orders",
        pathParameters: {}
      },
      messages: [{
        id: "30000000-0000-4000-8000-000000000001",
        threadId: thread.id,
        author: thread.reporter,
        body: "一覧の表示を確認してください",
        createdAt: thread.createdAt,
        version: 1
      }]
    };
    const transport = createTransport(async (path) => {
      if (path === `/threads/${thread.id}`) return { value: otherThread, etag: '"1"' };
      if (path.endsWith("/threads")) return { value: { items: [otherThread] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter({ navigate })} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "他の人の投稿を見る 1" }));
    const list = screen.getByRole("dialog", { name: "他の人の投稿を見る" });
    expect(within(list).getByRole("heading", { name: "orders.list" })).toBeTruthy();
    expect(within(list).getByText("一覧の表示を確認してください")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: /#1 使いやすさ/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(otherThread.location, otherThread.id));
    expect(await screen.findByRole("dialog", { name: "フィードバックスレッド" })).toBeTruthy();
  });

  it("cursorがある場合は全pageを取得して投稿件数へ反映する", async () => {
    const secondThread = { ...thread, id: "20000000-0000-4000-8000-000000000002", displayNumber: 2 };
    const transport = createTransport(async (path) => {
      if (path.includes("?cursor=next-page")) {
        return { value: { items: [secondThread], nextCursor: null }, etag: null };
      }
      if (path.endsWith("/threads")) {
        return { value: { items: [thread], nextCursor: "next-page" }, etag: null };
      }
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    expect(await screen.findByRole("button", { name: "他の人の投稿を見る 2" })).toBeTruthy();
  });

  it("screen座標とDOM内座標へ番号付きpinを配置する", async () => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 800 });
    const domThread = {
      ...thread,
      id: "20000000-0000-4000-8000-000000000002",
      displayNumber: 2,
      target: {
        schemaVersion: "1" as const,
        kind: "ui-element" as const,
        elementKey: "orders.save",
        relativeX: .25,
        relativeY: .5
      }
    };
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [thread, domThread] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <button type="button" data-feedback-key="orders.save">保存</button>
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    const owner = screen.getByRole("button", { name: "保存" });
    vi.spyOn(owner, "getBoundingClientRect").mockReturnValue({
      x: 100, y: 200, left: 100, top: 200, right: 300, bottom: 240, width: 200, height: 40,
      toJSON: () => ({})
    });
    fireEvent(window, new Event("resize"));

    const screenPin = await screen.findByRole("button", { name: /#1/ });
    const domPin = await screen.findByRole("button", { name: /#2/ });
    expect(screenPin.parentElement?.getAttribute("x")).toBe("496");
    expect(screenPin.parentElement?.getAttribute("y")).toBe("376");
    expect(domPin.parentElement?.getAttribute("x")).toBe("146");
    expect(domPin.parentElement?.getAttribute("y")).toBe("196");
  });

  it("thread drawerを開いてもpinを維持して選択中として表示する", async () => {
    const transport = createTransport(async (path) => {
      if (path === `/threads/${thread.id}`) return { value: thread, etag: '"1"' };
      if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    const pin = await screen.findByRole("button", { name: "#1" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);

    expect(await screen.findByRole("dialog", { name: "フィードバックスレッド" })).toBeTruthy();
    const retainedPin = screen.getByRole("button", { name: "#1" });
    expect(retainedPin.getAttribute("aria-pressed")).toBe("true");
    expect(retainedPin.classList.contains("is-active")).toBe(true);
  });

  it("thread切替時に旧証跡requestを無視し、置換・切替・unmountでBlob URLを解放する", async () => {
    const firstThread = { ...thread, evidenceAvailable: true };
    const secondThread = {
      ...firstThread,
      id: "20000000-0000-4000-8000-000000000002",
      displayNumber: 2
    };
    let resolveStaleEvidence: ((value: { bytes: Uint8Array; contentType: string; etag: null; contentRange: null }) => void) | undefined;
    const staleEvidence = new Promise<{ bytes: Uint8Array; contentType: string; etag: null; contentRange: null }>((resolve) => {
      resolveStaleEvidence = resolve;
    });
    const transport = createTransport(async (path) => {
      if (path === `/threads/${firstThread.id}`) return { value: firstThread, etag: '"1"' };
      if (path === `/threads/${secondThread.id}`) return { value: secondThread, etag: '"1"' };
      if (path.endsWith("/threads")) return { value: { items: [firstThread, secondThread] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    const requestBinary = vi.fn()
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png", etag: null, contentRange: null })
      .mockReturnValueOnce(staleEvidence)
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png", etag: null, contentRange: null })
      .mockResolvedValueOnce({ bytes: new Uint8Array([3]), contentType: "image/png", etag: null, contentRange: null });
    transport.requestBinary = requestBinary;
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:first-evidence")
      .mockReturnValueOnce("blob:second-evidence")
      .mockReturnValueOnce("blob:third-evidence");
    const revokeObjectURL = vi.fn();
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });

    const view = render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "#1" }));
    const evidenceButton = await screen.findByRole("button", { name: "証跡" });
    fireEvent.click(evidenceButton);
    expect(await screen.findByRole("img", { name: "証跡" })).toHaveProperty("src", "blob:first-evidence");

    fireEvent.click(evidenceButton);
    expect(screen.queryByRole("img", { name: "証跡" })).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-evidence");
    fireEvent.click(screen.getByRole("button", { name: "#2" }));
    expect(await screen.findByRole("heading", { name: /#2/ })).toBeTruthy();

    await act(async () => {
      resolveStaleEvidence?.({ bytes: new Uint8Array([9]), contentType: "image/png", etag: null, contentRange: null });
      await staleEvidence;
    });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img", { name: "証跡" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "証跡" }));
    expect(await screen.findByRole("img", { name: "証跡" })).toHaveProperty("src", "blob:second-evidence");
    fireEvent.click(screen.getByRole("button", { name: "#1" }));
    expect(await screen.findByRole("heading", { name: /#1/ })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "証跡" })).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second-evidence");

    fireEvent.click(screen.getByRole("button", { name: "証跡" }));
    expect(await screen.findByRole("img", { name: "証跡" })).toHaveProperty("src", "blob:third-evidence");
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:third-evidence");
  });

  it("thread切替時に旧threadの証跡取得errorを消去する", async () => {
    const firstThread = { ...thread, evidenceAvailable: true };
    const secondThread = {
      ...firstThread,
      id: "20000000-0000-4000-8000-000000000002",
      displayNumber: 2
    };
    const transport = createTransport(async (path) => {
      if (path === `/threads/${firstThread.id}`) return { value: firstThread, etag: '"1"' };
      if (path === `/threads/${secondThread.id}`) return { value: secondThread, etag: '"1"' };
      if (path.endsWith("/threads")) return { value: { items: [firstThread, secondThread] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    transport.requestBinary = vi.fn(async () => { throw new Error("旧threadの証跡取得に失敗しました"); });

    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: "#1" }));
    fireEvent.click(await screen.findByRole("button", { name: "証跡" }));
    expect((await screen.findByRole("alert")).textContent).toContain("旧threadの証跡取得に失敗しました");

    fireEvent.click(screen.getByRole("button", { name: "#2" }));
    expect(await screen.findByRole("heading", { name: /#2/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("img", { name: "証跡" })).toBeNull();
  });

  it("レビュー案内で対象画面と観点を確認できる", async () => {
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider adapter={createAdapter()} transport={transport} features={{ autoIntroduction: true }}>
        <FeedbackOverlay />
      </FeedbackProvider>
    );

    const guide = await screen.findByRole("dialog", { name: "テストレビュー" });
    expect(within(guide).getByRole("heading", { name: "今回確認してほしいこと" })).toBeTruthy();
    expect(within(guide).getByText("使いやすさ")).toBeTruthy();
    expect(within(guide).getByText("orders.detail")).toBeTruthy();
    fireEvent.click(within(guide).getByRole("button", { name: "確認してレビューを始める" }));
    expect(screen.queryByRole("dialog", { name: "テストレビュー" })).toBeNull();
    expect(screen.getByRole("button", { name: /レビュー通知：テストレビュー/ })).toBeTruthy();
  });

  it("locale差し替えとShadowRoot portalをhost CSSから分離して利用できる", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const transport = createTransport(async (path) => {
      if (path.endsWith("/threads")) return { value: { items: [] }, etag: null };
      throw new Error(`unexpected: ${path}`);
    });
    render(
      <FeedbackProvider
        adapter={createAdapter()}
        transport={transport}
        portalTarget={shadow}
        messages={{ launcher: "Send feedback" }}
      >
        <FeedbackOverlay />
      </FeedbackProvider>
    );
    await waitFor(() => expect(shadow.querySelector(".feedback-launcher")?.textContent).toContain("Send feedback"));
    host.remove();
  });
});

function createAdapter(overrides: Partial<FeedbackHostAdapter> = {}): FeedbackHostAdapter {
  return {
    getContext: () => ({
      schemaVersion: "1",
      applicationKey: "consumer",
      environmentKey: "test",
      externalWorkspaceKey: "workspace-1",
      release: "test"
    }),
    getLocation: () => ({
      schemaVersion: "1",
      pageKey: "orders.detail",
      routeTemplate: "/orders/{id}",
      pathParameters: { id: "O-1" }
    }),
    getAccessToken: async () => "token",
    navigate: () => undefined,
    ...overrides
  };
}

function createTransport(
  request: (path: string, options?: Parameters<FeedbackTransport["request"]>[1]) => Promise<{
    value: unknown;
    etag: string | null;
  }>,
  contextOverrides: Record<string, unknown> = {}
): FeedbackTransport {
  return {
    request: request as FeedbackTransport["request"],
    requestBinary: vi.fn(),
    getCapabilities: vi.fn(async () => ({
      apiVersion: "1.0",
      apiMajorVersion: 1,
      manifestSchemaVersions: ["1"],
      targetSchemaVersions: ["1"],
      evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
      features: []
    })),
    getReviewContext: vi.fn(async () => ({
      session,
      scope: "reviewable",
      posting: "allow",
      permissions: ["feedback.read", "feedback.comment", "feedback.manage"],
      participantPolicy: { mode: "authenticated-identity" },
      evidencePolicy: { enabled: true, maxBytes: 1024, acceptedContentTypes: ["image/png"] },
      ...contextOverrides
    }))
  } as unknown as FeedbackTransport;
}
