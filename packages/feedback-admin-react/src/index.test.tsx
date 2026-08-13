import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackTransport } from "@feedback/core";
import { FeedbackAdminConsole } from "./index";

const session = {
  id: "10000000-0000-4000-8000-000000000001",
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1",
  manifestVersion: "1",
  title: "レビュー1",
  description: null,
  status: "open",
  outOfScopePosting: "warn",
  startAt: null,
  endAt: null,
  scopes: [],
  perspectives: [{ code: "MAP_OPERATION", label: "地図操作", status: "active", guidance: null }],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const thread = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: session.id,
  displayNumber: 1,
  location: { schemaVersion: "1", pageKey: "home", routeTemplate: "/", pathParameters: {} },
  target: { schemaVersion: "1", kind: "screen-position", relativeX: 0.5, relativeY: 0.5 },
  perspectiveCode: "MAP_OPERATION",
  status: "open",
  reporter: { principalId: "user-1" },
  evidenceAvailable: false,
  messages: [],
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:00Z",
  version: 1
};

const evidenceThread = { ...thread, evidenceAvailable: true };
const secondEvidenceThread = {
  ...thread,
  id: "20000000-0000-4000-8000-000000000002",
  displayNumber: 2,
  perspectiveCode: "BUSINESS_FLOW",
  evidenceAvailable: true
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("FeedbackAdminConsole", () => {
  it("Web GISなしでsession/thread/deep linkを管理する", async () => {
    const openExternal = vi.fn();
    render(<FeedbackAdminConsole {...scope} transport={createTransport()} openExternal={openExternal} />);
    expect(await screen.findByText("#1 地図操作")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    const detailRoute = await screen.findByRole("checkbox", { name: /注文詳細.*\/orders\/\{id\}/ });
    fireEvent.click(detailRoute);
    expect((detailRoute as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "対象アプリでスレッドを開く" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
    const deepLink = new URL(String(openExternal.mock.calls[0][0]));
    expect(deepLink.origin).toBe("https://consumer.example");
    expect(deepLink.searchParams.get("feedbackThread")).toBe(thread.id);
  });

  it("新規レビューをJSON入力なしで設定できる", async () => {
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/sessions") return { value: session, etag: '"v1"' };
      return baseRequest(path, options);
    });
    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "新規作成" }));
    expect(screen.getByRole("dialog", { name: "レビューセッションの作成" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /注文一覧.*\/orders/ })).toBeTruthy();
    fireEvent.change(screen.getAllByRole("combobox", { name: "扱い" })[0], { target: { value: "active" } });
    fireEvent.change(screen.getAllByRole("combobox", { name: "扱い" })[3], { target: { value: "active" } });
    const mapAssignments = screen.getAllByRole("checkbox", { name: "地図操作" });
    expect(mapAssignments).toHaveLength(2);
    fireEvent.click(mapAssignments[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "タイトル" }), { target: { value: "受入レビュー" } });
    expect(screen.queryByText("Scope JSON")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "セッションを作成" }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => path === "/sessions")).toBe(true));
    const createCall = request.mock.calls.find(([path]) => path === "/sessions");
    expect((createCall?.[1] as { body?: unknown } | undefined)?.body).toMatchObject({
      title: "受入レビュー",
      status: "draft",
      scopes: [
        { pageKey: "orders.list", routeTemplate: "/orders", reviewable: true, perspectiveCodes: ["BUSINESS_FLOW"] },
        { pageKey: "orders.detail", routeTemplate: "/orders/{id}", reviewable: true, perspectiveCodes: ["BUSINESS_FLOW", "MAP_OPERATION"] }
      ],
      perspectives: [
        { code: "BUSINESS_FLOW", label: "業務フロー", status: "active", guidance: null },
        { code: "MAP_OPERATION", label: "地図操作", status: "active", guidance: null }
      ]
    });
  });

  it("メイン画面の開始導線から新規作成ダイアログを直接開く", async () => {
    render(<FeedbackAdminConsole {...scope} initialAction="create-review" transport={createTransport()} />);
    const dialog = await screen.findByRole("dialog", { name: "レビューセッションの作成" });
    expect((within(dialog).getByRole("combobox", { name: "状態" }) as HTMLSelectElement).value).toBe("open");
    expect((within(dialog).getAllByRole("combobox", { name: "扱い" })[0] as HTMLSelectElement).value).toBe("active");
    expect(dialog).toBeTruthy();
  });

  it("manifest・retention/export・membership・deliveryを独立tabで取得する", async () => {
    const request = vi.fn(createRequest());
    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 地図操作");
    for (const tab of ["アプリ設定", "保存・エクスポート", "メンバー", "通知"]) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      await waitFor(() => expect(request.mock.calls.some(([path]) => String(path).includes(expectedPath(tab)))).toBe(true));
    }
  });

  it("アプリ設定をJSON編集ではなく同期済み画面一覧として表示する", async () => {
    render(<FeedbackAdminConsole {...scope} transport={createTransport()} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "アプリ設定" }));
    expect(await screen.findByText("注文一覧")).toBeTruthy();
    expect(screen.getAllByText("2画面")).toHaveLength(2);
    expect(screen.getByText("メインアプリが持つ画面定義を自動で取り込みます。この画面でJSONを編集する必要はありません。")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Manifest JSON" })).toBeNull();
    expect(screen.queryByRole("button", { name: "アプリ設定を保存" })).toBeNull();
  });

  it("後着した古い証跡を無視し、最後に選択したthreadだけをモーダルへ表示する", async () => {
    const first = deferred<BinaryResource>();
    const second = deferred<BinaryResource>();
    const requestBinary = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => path.endsWith("/threads")
      ? { value: { items: [evidenceThread, secondEvidenceThread] }, etag: null }
      : baseRequest(path, options));

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#2 業務フロー");
    const evidenceButtons = screen.getAllByRole("button", { name: "証跡" });
    fireEvent.click(evidenceButtons[0]);
    expect(screen.getByRole("dialog", { name: "証跡 #1" })).toBeTruthy();
    fireEvent.click(evidenceButtons[1]);
    expect(screen.getByRole("dialog", { name: "証跡 #2" })).toBeTruthy();

    second.resolve(binaryResource([2]));
    expect(await screen.findByRole("img", { name: "スレッド #2 の証跡" })).toHaveProperty("src", "blob:second");
    first.resolve(binaryResource([1]));
    await act(async () => { await first.promise; });

    expect(screen.getByRole("dialog", { name: "証跡 #2" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "証跡 #1" })).toBeNull();
    expect(createObjectURL).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "証跡を閉じる" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });

  it("証跡の再選択・セッション切替・unmountでObject URLを解放する", async () => {
    const anotherSession = { ...session, id: "10000000-0000-4000-8000-000000000002", title: "レビュー2" };
    const anotherThread = { ...secondEvidenceThread, sessionId: anotherSession.id };
    const requestBinary = vi.fn()
      .mockResolvedValueOnce(binaryResource([1]))
      .mockResolvedValueOnce(binaryResource([2]));
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path.startsWith("/sessions?")) return { value: { items: [session, anotherSession] }, etag: null };
      if (path === `/sessions/${session.id}/threads`) return { value: { items: [evidenceThread] }, etag: null };
      if (path === `/sessions/${anotherSession.id}/threads`) return { value: { items: [anotherThread] }, etag: null };
      return baseRequest(path, options);
    });

    const rendered = render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "証跡" }));
    await screen.findByRole("img", { name: "スレッド #1 の証跡" });
    fireEvent.click(screen.getByRole("button", { name: /レビュー2/ }));
    expect(screen.queryByRole("dialog", { name: "証跡 #1" })).toBeNull();
    await screen.findByText("#2 業務フロー");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");

    fireEvent.click(screen.getByRole("button", { name: "証跡" }));
    await screen.findByRole("img", { name: "スレッド #2 の証跡" });
    rendered.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });

  it("証跡の読込失敗をモーダル内に表示し、同じthreadを再試行する", async () => {
    const requestBinary = vi.fn()
      .mockRejectedValueOnce(new Error("画像が見つかりません"))
      .mockResolvedValueOnce(binaryResource([1]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => path.endsWith("/threads")
      ? { value: { items: [evidenceThread] }, etag: null }
      : baseRequest(path, options));

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "証跡" }));
    expect(await screen.findByText(/画像が見つかりません/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByRole("img", { name: "スレッド #1 の証跡" })).toBeTruthy();
    expect(requestBinary).toHaveBeenCalledTimes(2);
  });

  it.each(["csv", "xlsx"] as const)("Exportを1秒ごとに追跡し、完了時に作成時形式（%s）で一度だけ自動ダウンロードする", async (requestedFormat) => {
    const exportId = "30000000-0000-4000-8000-000000000001";
    let refreshCount = 0;
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/exports") return { value: exportJob(exportId, "queued"), etag: null };
      if (path === `/exports/${exportId}`) {
        refreshCount += 1;
        return { value: exportJob(exportId, refreshCount === 1 ? "running" : "completed"), etag: null };
      }
      return baseRequest(path, options);
    });
    const requestBinary = vi.fn().mockResolvedValue(binaryResource([1, 2]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const downloads: Array<{ name: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, attached: document.body.contains(this) });
    });

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "保存・エクスポート" }));
    await screen.findByText("データをエクスポート");
    fireEvent.change(screen.getByRole("combobox", { name: "ファイル形式" }), { target: { value: requestedFormat } });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    expect(screen.getByText("状態: 待機中")).toBeTruthy();
    expect(screen.getByRole("button", { name: "エクスポートを作成" })).toHaveProperty("disabled", true);

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("状態: 作成中")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("状態: 完了")).toBeTruthy();
    expect(requestBinary).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([{ name: `feedback-${exportId}.${requestedFormat}`, attached: true }]);
    expect(document.querySelector(`a[download="feedback-${exportId}.${requestedFormat}"]`)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(requestBinary).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
  });

  it("新規jobへの切替後は旧downloadの完了を無視し、unmount後はpollingしない", async () => {
    const firstId = "30000000-0000-4000-8000-000000000010";
    const secondId = "30000000-0000-4000-8000-000000000011";
    const oldDownload = deferred<BinaryResource>();
    let createCount = 0;
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/exports") {
        createCount += 1;
        return { value: exportJob(createCount === 1 ? firstId : secondId, createCount === 1 ? "completed" : "queued"), etag: null };
      }
      if (path === `/exports/${secondId}`) return { value: exportJob(secondId, "running"), etag: null };
      return baseRequest(path, options);
    });
    const requestBinary = vi.fn().mockReturnValue(oldDownload.promise);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:obsolete");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    const rendered = render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "保存・エクスポート" }));
    await screen.findByText("データをエクスポート");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    expect(screen.getByText("状態: 完了")).toBeTruthy();
    expect(requestBinary).toHaveBeenCalledWith(`/exports/${firstId}/download`);
    expect(screen.getByRole("button", { name: "状態を再確認" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "ダウンロード中..." })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "状態を再確認" }));
    fireEvent.click(screen.getByRole("button", { name: "ダウンロード中..." }));
    expect(requestBinary).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([path]) => path === `/exports/${firstId}`)).toHaveLength(0);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    expect(screen.getByText("状態: 待機中")).toBeTruthy();
    oldDownload.resolve(binaryResource([1]));
    await act(async () => { await oldDownload.promise; });
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(screen.getByText("状態: 待機中")).toBeTruthy();

    rendered.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(request.mock.calls.filter(([path]) => path === `/exports/${secondId}`)).toHaveLength(0);
  });

  it("downloadのDOM操作が失敗してもObject URLを後続タスクで解放する", async () => {
    const exportId = "30000000-0000-4000-8000-000000000012";
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => path === "/exports"
      ? { value: exportJob(exportId, "completed"), etag: null }
      : baseRequest(path, options));
    const requestBinary = vi.fn().mockResolvedValue(binaryResource([1]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:click-error");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("clickに失敗しました"); });

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "保存・エクスポート" }));
    await screen.findByText("データをエクスポート");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    expect(screen.getByText(/clickに失敗しました/)).toBeTruthy();
    expect(document.querySelector(`a[download="feedback-${exportId}.csv"]`)).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:click-error");
    expect(screen.getByRole("button", { name: "ファイルを再ダウンロード" })).toHaveProperty("disabled", false);
  });

  it("状態取得と自動downloadの失敗後にjobを保持し、手動操作で再開できる", async () => {
    const exportId = "30000000-0000-4000-8000-000000000002";
    let refreshCount = 0;
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/exports") return { value: exportJob(exportId, "queued"), etag: null };
      if (path === `/exports/${exportId}`) {
        refreshCount += 1;
        if (refreshCount === 1) throw new Error("状態APIが停止中です");
        return { value: exportJob(exportId, "completed"), etag: null };
      }
      return baseRequest(path, options);
    });
    const requestBinary = vi.fn()
      .mockRejectedValueOnce(new Error("download APIが停止中です"))
      .mockResolvedValueOnce(binaryResource([1]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:manual");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request, requestBinary)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "保存・エクスポート" }));
    await screen.findByText("データをエクスポート");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(/状態APIが停止中です/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(refreshCount).toBe(1);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "状態を再確認" })); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("状態: 完了")).toBeTruthy();
    expect(screen.getByText(/download APIが停止中です/)).toBeTruthy();
    expect(requestBinary).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(requestBinary).toHaveBeenCalledTimes(1);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "ファイルを再ダウンロード" })); await Promise.resolve(); });
    expect(requestBinary).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/download APIが停止中です/)).toBeNull();
  });

  it("Export失敗時はサーバーエラーを日本語状態とともに表示してpollingを停止する", async () => {
    const exportId = "30000000-0000-4000-8000-000000000003";
    const baseRequest = createRequest();
    const request = vi.fn(async (path: string, options?: unknown) => {
      if (path === "/exports") return { value: exportJob(exportId, "queued"), etag: null };
      if (path === `/exports/${exportId}`) return { value: exportJob(exportId, "failed", "CSV生成に失敗しました"), etag: null };
      return baseRequest(path, options);
    });

    render(<FeedbackAdminConsole {...scope} transport={createTransport(request)} />);
    await screen.findByText("#1 地図操作");
    fireEvent.click(screen.getByRole("button", { name: "保存・エクスポート" }));
    await screen.findByText("データをエクスポート");
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "エクスポートを作成" })); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("状態: 失敗")).toBeTruthy();
    expect(screen.getByText(/CSV生成に失敗しました/)).toBeTruthy();
    const statusCalls = request.mock.calls.filter(([path]) => path === `/exports/${exportId}`).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(request.mock.calls.filter(([path]) => path === `/exports/${exportId}`)).toHaveLength(statusCalls);
  });
});

const scope = {
  applicationKey: "consumer",
  environmentKey: "test",
  externalWorkspaceKey: "workspace-1"
};

function expectedPath(tab: string): string {
  return ({ "アプリ設定": "/manifest", "保存・エクスポート": "/retention-policy", メンバー: "/memberships", 通知: "/connector-types" })[tab] ?? "";
}

function createTransport(
  request: ReturnType<typeof vi.fn> = vi.fn(createRequest()),
  requestBinary: ReturnType<typeof vi.fn> = vi.fn()
): FeedbackTransport {
  return {
    request: request as unknown as FeedbackTransport["request"],
    requestBinary: requestBinary as unknown as FeedbackTransport["requestBinary"],
    getCapabilities: vi.fn(),
    getReviewContext: vi.fn()
  };
}

type BinaryResource = Awaited<ReturnType<FeedbackTransport["requestBinary"]>>;

function binaryResource(bytes: number[]): BinaryResource {
  return { bytes: new Uint8Array(bytes), contentType: "image/png", etag: null, contentRange: null };
}

function exportJob(id: string, status: "queued" | "running" | "completed" | "failed", error: string | null = null) {
  return { id, status, downloadUrl: null, createdAt: "2026-08-13T00:00:00Z", error };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRequest() {
  return async (path: string, _options?: unknown) => {
    if (path.startsWith("/sessions?")) return { value: { items: [session] }, etag: null };
    if (path.endsWith("/threads")) return { value: { items: [thread] }, etag: null };
    if (path.endsWith("/deep-link")) return { value: { url: "https://consumer.example/?feedbackThread=thread-1" }, etag: null };
    if (path.includes("/manifest")) return { value: {
      schemaVersion: "1", applicationKey: "consumer", displayName: "Consumer", manifestVersion: "1",
      routes: [
        { pageKey: "orders.list", template: "/orders", label: "注文一覧" },
        { pageKey: "orders.detail", template: "/orders/{id}", label: "注文詳細" }
      ]
    }, etag: '"v1"' };
    if (path.startsWith("/retention-policy")) return { value: { evidenceRetentionDays: null, exportRetentionDays: 7 }, etag: '"v1"' };
    if (path.startsWith("/backup-policy")) return { value: { policy: { enabled: false, timezone: "Asia/Tokyo", fullBackupAt: "02:00", incrementalIntervalMinutes: 60, includeEvidence: true, retentionDays: null }, nextExecutionAt: null, nextFullAt: null, nextIncrementalAt: null, lastSuccessfulAt: null, changeCursor: 0, auditCursor: 0 }, etag: '"v1"' };
    if (path.startsWith("/backups")) return { value: { items: [] }, etag: null };
    if (path.startsWith("/memberships")) return { value: [], etag: null };
    if (path.startsWith("/notification-settings")) return { value: { webhookEnabled: false, webhookEndpoint: null, includeBody: false, includeEvidence: false }, etag: '"v1"' };
    if (path.startsWith("/notification-deliveries")) return { value: [], etag: null };
    if (path.startsWith("/connector-types")) return { value: [], etag: null };
    if (path.startsWith("/notification-connectors")) return { value: [], etag: null };
    throw new Error(`unexpected: ${path}`);
  };
}
