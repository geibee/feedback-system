# Backlog Stage B live Conformance fixture

`live-conformance.json`は、管理されたBacklog SaaS無料体験spaceで実際の`@geibee/feedback-connector-backlog`を通した匿名化証跡である。tenant、project、issue、comment、account、credentialの識別子を含めない。

create、reply、append-only revisionのcommit後応答喪失、4 Text custom fieldによるthread／resource検索、複数候補の`repair_required`、別process再構築、attachment read／uploadの`unsupported`、run-owned issueのcleanupを同じrunで確認した。Backlog検索はreplica間で一時的に0件となり得るため、write前だけread-onlyの連続可視性を確認し、commit後は自動再書込みせずrecover-onlyとした。

証跡の`implementationDigest`はBacklog Connector、transport、DTO mapping、provisioning、live runnerへ束縛する。
