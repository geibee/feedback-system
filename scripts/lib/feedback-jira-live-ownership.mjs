// Service内で作成したprovider objectも、Gatewayの解決callbackを連結してcleanup対象へ追加する。
export function trackJiraLiveRepository(repository, issueIds) {
  const createThread = repository.createThread.bind(repository);
  repository.createThread = (query, options) => createThread(query, {
    ...options,
    onThreadResolved(reference) {
      if (reference?.providerKey !== "jira-cloud" || typeof reference.objectId !== "string") {
        throw new Error("Jira run-owned provider参照が不正です");
      }
      issueIds.add(reference.objectId);
      options?.onThreadResolved?.(reference);
    }
  });
  return repository;
}
