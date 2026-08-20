import { createContext, useContext, type PropsWithChildren } from "react";
import type {
  ClientStatePort,
  FeedbackRedmineHostAdapter,
  RedmineFeedbackPort
} from "@feedback/redmine-core";
import type { FeedbackPinPositionProvider, FeedbackTargetResolver } from "@feedback/core";

export type RedmineFeedbackRuntime = {
  port: RedmineFeedbackPort;
  clientState: ClientStatePort;
  adapter: FeedbackRedmineHostAdapter;
  profileId: string;
  contextMenu?: boolean;
  targetResolver?: FeedbackTargetResolver<Element>;
  pinPositionProvider?: FeedbackPinPositionProvider;
};

const RuntimeContext = createContext<RedmineFeedbackRuntime | null>(null);

export function RedmineFeedbackProvider(
  props: PropsWithChildren<{ runtime: RedmineFeedbackRuntime }>
) {
  return <RuntimeContext.Provider value={props.runtime}>{props.children}</RuntimeContext.Provider>;
}

export function useRedmineFeedbackRuntime(): RedmineFeedbackRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("RedmineFeedbackProviderがありません");
  return runtime;
}
