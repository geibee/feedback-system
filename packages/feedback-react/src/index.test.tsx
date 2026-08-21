import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryFeedbackTelemetry, type FeedbackHostAdapter, type FeedbackTransport } from "@geibee/feedback-core";
import { FeedbackProvider, useFeedback } from "./index";

const adapter: FeedbackHostAdapter = {
  getContext: () => ({
    schemaVersion: "1",
    applicationKey: "sample-app",
    environmentKey: "test",
    externalWorkspaceKey: "workspace-1",
    release: "test"
  }),
  getLocation: () => ({
    schemaVersion: "1",
    pageKey: "orders.list",
    routeTemplate: "/orders",
    pathParameters: {}
  }),
  getAccessToken: async () => "token",
  navigate: () => undefined
};

describe("FeedbackProvider", () => {
  it("capabilities確認後にreview contextを公開する", async () => {
    const transport = {
      getCapabilities: vi.fn(async () => ({
        apiVersion: "1.0",
        apiMajorVersion: 1,
        manifestSchemaVersions: ["1"],
        targetSchemaVersions: ["1"],
        evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
        features: []
      })),
      getReviewContext: vi.fn(async () => ({
        session: null,
        scope: "reviewable",
        posting: "allow",
        permissions: ["feedback.comment"],
        participantPolicy: { mode: "authenticated-identity" },
        evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
      })),
      request: vi.fn(),
      requestBinary: vi.fn()
    } as FeedbackTransport;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FeedbackProvider, { adapter, transport, children });
    const { result } = renderHook(() => useFeedback(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.reviewContext?.posting).toBe("allow");
  });

  it("service障害をunavailable stateへ閉じ込め、再試行できる", async () => {
    let unavailable = true;
    const onUnavailable = vi.fn();
    const telemetry = createInMemoryFeedbackTelemetry();
    const transport = {
      getCapabilities: vi.fn(async () => {
        if (unavailable) throw new Error("down");
        return {
          apiVersion: "1.0",
          apiMajorVersion: 1,
          manifestSchemaVersions: ["1"],
          targetSchemaVersions: ["1"],
          evidence: { maxBytes: 1, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
          features: []
        };
      }),
      getReviewContext: vi.fn(async () => null),
      request: vi.fn(),
      requestBinary: vi.fn()
    } as unknown as FeedbackTransport;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FeedbackProvider, { adapter, transport, onUnavailable, telemetry, children });
    const { result } = renderHook(() => useFeedback(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(telemetry.snapshot().service_unavailable).toBe(1);
    unavailable = false;
    await act(() => result.current.refresh());
    expect(result.current.state).toBe("ready");
  });

  it("host context変更時に古い読込を破棄して最新contextを公開する", async () => {
    let workspace = "workspace-east";
    let notifyContextChanged: (() => void) | undefined;
    let resolveEast: ((value: Awaited<ReturnType<FeedbackTransport["getReviewContext"]>>) => void) | undefined;
    const eastReviewContext = new Promise<Awaited<ReturnType<FeedbackTransport["getReviewContext"]>>>((resolve) => {
      resolveEast = resolve;
    });
    const unsubscribe = vi.fn();
    const changingAdapter: FeedbackHostAdapter = {
      ...adapter,
      getContext: () => ({
        ...adapter.getContext(),
        externalWorkspaceKey: workspace
      }),
      subscribe: (listener) => {
        notifyContextChanged = listener;
        return unsubscribe;
      }
    };
    const transport = {
      getCapabilities: vi.fn(async () => ({
        apiVersion: "1.0",
        apiMajorVersion: 1,
        manifestSchemaVersions: ["1"],
        targetSchemaVersions: ["1"],
        evidence: { maxBytes: 1024, maxCountPerWorkspace: 1000, acceptedContentTypes: ["image/png"] },
        features: []
      })),
      getReviewContext: vi.fn(async (context) => {
        if (context.externalWorkspaceKey === "workspace-east") return eastReviewContext;
        return {
          session: null,
          scope: "reviewable" as const,
          posting: "deny" as const,
          permissions: [],
          participantPolicy: { mode: "authenticated-identity" as const },
          evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
        };
      }),
      request: vi.fn(),
      requestBinary: vi.fn()
    } as FeedbackTransport;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(FeedbackProvider, { adapter: changingAdapter, transport, children });
    const { result, unmount } = renderHook(() => useFeedback(), { wrapper });

    await waitFor(() => expect(transport.getReviewContext).toHaveBeenCalledTimes(1));
    act(() => {
      workspace = "workspace-west";
      notifyContextChanged?.();
    });
    await waitFor(() => expect(result.current.hostContext?.externalWorkspaceKey).toBe("workspace-west"));
    expect(result.current.reviewContext?.posting).toBe("deny");

    await act(async () => {
      resolveEast?.({
        session: null,
        scope: "reviewable",
        posting: "allow",
        permissions: ["feedback.comment"],
        participantPolicy: { mode: "authenticated-identity" },
        evidencePolicy: { enabled: false, maxBytes: 1024, acceptedContentTypes: ["image/png"] }
      });
      await Promise.resolve();
    });
    expect(result.current.hostContext?.externalWorkspaceKey).toBe("workspace-west");
    expect(result.current.reviewContext?.posting).toBe("deny");

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
