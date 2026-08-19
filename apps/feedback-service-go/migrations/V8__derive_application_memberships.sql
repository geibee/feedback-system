WITH aggregated AS (
    SELECT workspace.application_id,
           membership.user_id,
           ARRAY(
               SELECT DISTINCT permission
               FROM feedback.workspace_memberships source_membership
               JOIN feedback.workspaces source_workspace ON source_workspace.id = source_membership.workspace_id
               CROSS JOIN LATERAL unnest(source_membership.permissions) permission
               WHERE source_workspace.application_id = workspace.application_id
                 AND source_membership.user_id = membership.user_id
               ORDER BY permission
           ) AS permissions
    FROM feedback.workspace_memberships membership
    JOIN feedback.workspaces workspace ON workspace.id = membership.workspace_id
    GROUP BY workspace.application_id, membership.user_id
)
INSERT INTO feedback.application_memberships (application_id, user_id, permissions)
SELECT application_id, user_id, permissions
FROM aggregated
ON CONFLICT (application_id, user_id) DO UPDATE
SET permissions = EXCLUDED.permissions;

DELETE FROM feedback.application_memberships membership
WHERE NOT EXISTS (
    SELECT 1
    FROM feedback.workspace_memberships workspace_membership
    JOIN feedback.workspaces workspace ON workspace.id = workspace_membership.workspace_id
    WHERE workspace.application_id = membership.application_id
      AND workspace_membership.user_id = membership.user_id
);

COMMENT ON TABLE feedback.application_memberships IS
    'workspace_membershipsを正本としてapplication内のpermission和集合を保持する派生membership';
