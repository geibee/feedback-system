ALTER TABLE feedback.feedback_threads
    ADD COLUMN assignee_user_id uuid REFERENCES feedback.users(id) ON DELETE SET NULL,
    ADD COLUMN priority varchar(20) CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    ADD COLUMN labels text[] NOT NULL DEFAULT ARRAY[]::text[],
    ADD CONSTRAINT feedback_threads_labels_count CHECK (cardinality(labels) <= 10);

ALTER TABLE feedback.export_jobs
    DROP CONSTRAINT export_jobs_format_check,
    ALTER COLUMN format TYPE varchar(30),
    ADD CONSTRAINT export_jobs_format_check CHECK (format IN ('csv', 'xlsx', 'evidence-package'));

CREATE INDEX feedback_threads_updated_idx
    ON feedback.feedback_threads(session_id, updated_at DESC, id DESC);
CREATE INDEX feedback_threads_assignee_idx
    ON feedback.feedback_threads(workspace_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX feedback_threads_priority_idx
    ON feedback.feedback_threads(workspace_id, priority) WHERE priority IS NOT NULL;
CREATE INDEX feedback_threads_labels_idx
    ON feedback.feedback_threads USING gin(labels);

CREATE TABLE feedback.thread_participants (
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    participated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX thread_participants_user_idx
    ON feedback.thread_participants(user_id, participated_at DESC);

CREATE TABLE feedback.message_reactions (
    message_id uuid NOT NULL REFERENCES feedback.feedback_messages(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    reaction varchar(20) NOT NULL CHECK (reaction IN ('thumbs_up', 'check', 'eyes', 'question')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, reaction)
);
CREATE INDEX message_reactions_message_idx
    ON feedback.message_reactions(message_id, reaction, created_at);

CREATE TABLE feedback.reaction_events (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES feedback.feedback_messages(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    reaction varchar(20) NOT NULL CHECK (reaction IN ('thumbs_up', 'check', 'eyes', 'question')),
    action varchar(20) NOT NULL CHECK (action IN ('added', 'removed')),
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reaction_events_workspace_idx
    ON feedback.reaction_events(workspace_id, occurred_at, id);

CREATE TABLE feedback.thread_triage_events (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    actor_user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    assignee_user_id uuid REFERENCES feedback.users(id) ON DELETE SET NULL,
    priority varchar(20) CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    labels text[] NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_triage_events_workspace_idx
    ON feedback.thread_triage_events(workspace_id, occurred_at, id);

CREATE TABLE feedback.reply_notifications (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES feedback.workspaces(id) ON DELETE CASCADE,
    recipient_user_id uuid NOT NULL REFERENCES feedback.users(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES feedback.feedback_threads(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES feedback.feedback_messages(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    UNIQUE (recipient_user_id, message_id)
);
CREATE INDEX reply_notifications_unread_idx
    ON feedback.reply_notifications(recipient_user_id, workspace_id, created_at DESC)
    WHERE read_at IS NULL;

-- 既存主体はworkspace内でsubjectが一意にuserへ解決できる場合だけ安全に参加者へ移行する。
WITH candidates AS (
    SELECT thread.id AS thread_id, min(member.user_id::text)::uuid AS user_id
    FROM feedback.feedback_threads thread
    JOIN feedback.workspace_memberships member ON member.workspace_id = thread.workspace_id
    JOIN feedback.users app_user ON app_user.id = member.user_id
    WHERE app_user.subject = thread.reporter_principal_id
    GROUP BY thread.id
    HAVING count(*) = 1
)
INSERT INTO feedback.thread_participants (thread_id, user_id)
SELECT thread_id, user_id FROM candidates
ON CONFLICT DO NOTHING;

WITH candidates AS (
    SELECT message.thread_id, message.id AS message_id, min(member.user_id::text)::uuid AS user_id
    FROM feedback.feedback_messages message
    JOIN feedback.feedback_threads thread ON thread.id = message.thread_id
    JOIN feedback.workspace_memberships member ON member.workspace_id = thread.workspace_id
    JOIN feedback.users app_user ON app_user.id = member.user_id
    WHERE app_user.subject = message.author_principal_id
    GROUP BY message.thread_id, message.id
    HAVING count(*) = 1
)
INSERT INTO feedback.thread_participants (thread_id, user_id, participated_at)
SELECT candidates.thread_id, candidates.user_id, message.created_at
FROM candidates JOIN feedback.feedback_messages message ON message.id = candidates.message_id
ON CONFLICT (thread_id, user_id) DO UPDATE
SET participated_at = LEAST(feedback.thread_participants.participated_at, EXCLUDED.participated_at);
