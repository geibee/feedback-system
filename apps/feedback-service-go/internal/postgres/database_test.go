package postgres

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/admin"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/auth"
	"github.com/geibee/feedback-system/apps/feedback-service-go/internal/usecase"
)

func TestNewPoolConfig(t *testing.T) {
	t.Parallel()

	config, err := NewPoolConfig(Config{
		URL:               "jdbc:postgresql://db.example.test:5432/feedback?sslmode=require",
		User:              "feedback_user",
		Password:          "secret",
		PoolSize:          7,
		ConnectionTimeout: 4 * time.Second,
		StatementTimeout:  1250 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewPoolConfig() error = %v", err)
	}
	if config.ConnConfig.Host != "db.example.test" || config.ConnConfig.Port != 5432 ||
		config.ConnConfig.Database != "feedback" {
		t.Fatalf("接続先が不正です: %+v", config.ConnConfig.Config)
	}
	if config.ConnConfig.User != "feedback_user" || config.ConnConfig.Password != "secret" {
		t.Fatal("明示した資格情報がURLより優先されていません")
	}
	if config.MaxConns != 7 {
		t.Fatalf("MaxConns = %d, want 7", config.MaxConns)
	}
	if config.ConnConfig.ConnectTimeout != 4*time.Second {
		t.Fatalf("ConnectTimeout = %s", config.ConnConfig.ConnectTimeout)
	}
	if got := config.ConnConfig.RuntimeParams["statement_timeout"]; got != "1250" {
		t.Fatalf("statement_timeout = %q, want 1250", got)
	}
}

func TestNewPoolConfigRejectsInvalidValues(t *testing.T) {
	t.Parallel()

	valid := Config{
		URL:               "postgresql://localhost/feedback",
		User:              "feedback",
		Password:          "secret",
		PoolSize:          1,
		ConnectionTimeout: time.Second,
		StatementTimeout:  time.Second,
	}
	tests := map[string]func(*Config){
		"URL":                func(value *Config) { value.URL = "" },
		"user":               func(value *Config) { value.User = "" },
		"password":           func(value *Config) { value.Password = "" },
		"pool size":          func(value *Config) { value.PoolSize = 0 },
		"connection timeout": func(value *Config) { value.ConnectionTimeout = 0 },
		"statement timeout":  func(value *Config) { value.StatementTimeout = time.Microsecond },
	}
	for name, mutate := range tests {
		name, mutate := name, mutate
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			settings := valid
			mutate(&settings)
			if _, err := NewPoolConfig(settings); err == nil {
				t.Fatal("不正値が受理されました")
			}
		})
	}
}

func TestInTransactionCommitsOnlyOnSuccess(t *testing.T) {
	t.Parallel()

	value := &fakeManagedTx{}
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return value, nil
	}})
	called := false
	err := db.InTransaction(context.Background(), func(_ context.Context, got Tx) error {
		called = true
		if got != value {
			t.Fatal("callbackへ異なるtransactionが渡されました")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("InTransaction() error = %v", err)
	}
	if !called || value.commits.Load() != 1 || value.rollbacks.Load() != 0 {
		t.Fatalf("called=%v commits=%d rollbacks=%d", called, value.commits.Load(), value.rollbacks.Load())
	}
}

func TestInTransactionRejectsNilCallbackWithoutBegin(t *testing.T) {
	t.Parallel()

	var begins atomic.Int32
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		begins.Add(1)
		return &fakeManagedTx{}, nil
	}})
	if err := db.InTransaction(context.Background(), nil); err == nil {
		t.Fatal("nil callbackが受理されました")
	}
	if begins.Load() != 0 {
		t.Fatal("callback検証前にtransactionが開始されました")
	}
}

func TestInTransactionReturnsBeginError(t *testing.T) {
	t.Parallel()

	want := errors.New("begin failed")
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return nil, want
	}})
	called := false
	err := db.InTransaction(context.Background(), func(context.Context, Tx) error {
		called = true
		return nil
	})
	if !errors.Is(err, want) || called {
		t.Fatalf("InTransaction() error=%v called=%v", err, called)
	}
}

func TestInTransactionRollsBackError(t *testing.T) {
	t.Parallel()

	want := errors.New("callback failed")
	rollbackErr := errors.New("rollback failed")
	value := &fakeManagedTx{rollbackErr: rollbackErr}
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return value, nil
	}})
	err := db.InTransaction(context.Background(), func(context.Context, Tx) error { return want })
	if !errors.Is(err, want) || !errors.Is(err, rollbackErr) {
		t.Fatalf("InTransaction() error = %v, want callbackとrollbackの両方", err)
	}
	if value.commits.Load() != 0 || value.rollbacks.Load() != 1 {
		t.Fatalf("commits=%d rollbacks=%d", value.commits.Load(), value.rollbacks.Load())
	}
}

func TestInTransactionRollsBackPanicAndPreservesValue(t *testing.T) {
	t.Parallel()

	value := &fakeManagedTx{}
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return value, nil
	}})
	want := &struct{ message string }{"panic value"}
	defer func() {
		if recovered := recover(); recovered != want {
			t.Fatalf("recover = %#v, want original panic", recovered)
		}
		if value.commits.Load() != 0 || value.rollbacks.Load() != 1 {
			t.Fatalf("commits=%d rollbacks=%d", value.commits.Load(), value.rollbacks.Load())
		}
	}()
	_ = db.InTransaction(context.Background(), func(context.Context, Tx) error {
		panic(want)
	})
}

func TestInTransactionReturnsCommitError(t *testing.T) {
	t.Parallel()

	want := errors.New("commit failed")
	value := &fakeManagedTx{commitErr: want}
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return value, nil
	}})
	err := db.InTransaction(context.Background(), func(context.Context, Tx) error { return nil })
	if !errors.Is(err, want) || !strings.Contains(err.Error(), "commit") {
		t.Fatalf("InTransaction() error = %v", err)
	}
}

func TestMutationRollsBackWhenSucceededAuditInsertFails(t *testing.T) {
	t.Parallel()

	auditFailure := errors.New("audit insert failed")
	value := &auditFailureTx{auditFailure: auditFailure}
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		return value, nil
	}})
	scope := auth.ResourceScope{TenantID: "tenant", ApplicationID: "application", WorkspaceID: "workspace"}
	err := db.InTransaction(context.Background(), func(ctx context.Context, tx Tx) error {
		if _, err := tx.Exec(ctx, "UPDATE feedback.review_sessions SET title = $1", "更新後"); err != nil {
			return err
		}
		return insertAudit(ctx, tx, usecase.AuditEvent{
			Scope: &scope, PrincipalID: "subject", Action: "session.patch",
			ResourceType: "session", ResourceID: "session-id", Outcome: "succeeded", RequestID: "request-id",
		})
	})
	if !errors.Is(err, auditFailure) {
		t.Fatalf("InTransaction() error = %v", err)
	}
	if value.businessWrites != 1 || value.auditWrites != 1 || value.commits.Load() != 0 || value.rollbacks.Load() != 1 {
		t.Fatalf("business=%d audit=%d commits=%d rollbacks=%d", value.businessWrites, value.auditWrites,
			value.commits.Load(), value.rollbacks.Load())
	}
}

func TestRecordMembershipSuccessIncludesMutationDiff(t *testing.T) {
	t.Parallel()

	tx := &membershipAuditTx{}
	scope := auth.ResourceScope{TenantID: "tenant", ApplicationID: "application", WorkspaceID: "workspace"}
	before := admin.Member{UserID: "user", Permissions: []auth.Permission{auth.PermissionAdmin}, Version: 1}
	after := admin.Member{UserID: "user", Permissions: []auth.Permission{auth.PermissionRead}, Version: 2}
	if err := recordMembershipSuccess(
		context.Background(), tx, scope, auth.Principal{Subject: "actor"},
		"membership.patch", "request-id", &before, &after,
	); err != nil {
		t.Fatal(err)
	}
	if len(tx.arguments) != 11 || tx.arguments[5] != "membership.patch" || tx.arguments[7] != "user" ||
		tx.arguments[8] != "succeeded" || tx.arguments[9] != "request-id" {
		t.Fatalf("audit arguments = %#v", tx.arguments)
	}
	changes, ok := tx.arguments[10].(string)
	if !ok || !strings.Contains(changes, `"version":1`) || !strings.Contains(changes, `"version":2`) {
		t.Fatalf("audit changes = %#v", tx.arguments[10])
	}
}

func TestInTransactionRejectsNestedContext(t *testing.T) {
	t.Parallel()

	var begins atomic.Int32
	db := newTestDatabase(&fakePool{beginFn: func(context.Context) (managedTx, error) {
		begins.Add(1)
		return &fakeManagedTx{}, nil
	}})
	err := db.InTransaction(context.Background(), func(ctx context.Context, _ Tx) error {
		return db.InTransaction(ctx, func(context.Context, Tx) error {
			t.Fatal("nested callbackを実行してはいけません")
			return nil
		})
	})
	if !errors.Is(err, ErrNestedTransaction) {
		t.Fatalf("InTransaction() error = %v, want ErrNestedTransaction", err)
	}
	if begins.Load() != 1 {
		t.Fatalf("begin count = %d, want 1", begins.Load())
	}
}

func TestDatabasePingUsesTimeoutAndCloseIsIdempotent(t *testing.T) {
	t.Parallel()

	value := &fakePool{pingFn: func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	db := &Database{pool: value, connectionTimeout: time.Millisecond}
	if err := db.Ping(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Ping() error = %v", err)
	}

	var group sync.WaitGroup
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			db.Close()
		}()
	}
	group.Wait()
	if value.closes.Load() != 1 {
		t.Fatalf("close count = %d, want 1", value.closes.Load())
	}
}

func newTestDatabase(value pool) *Database {
	return &Database{pool: value, connectionTimeout: time.Second}
}

type fakePool struct {
	beginFn func(context.Context) (managedTx, error)
	pingFn  func(context.Context) error
	closes  atomic.Int32
}

func (p *fakePool) Begin(ctx context.Context) (managedTx, error) {
	return p.beginFn(ctx)
}

func (p *fakePool) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("unexpected Exec")
}

func (p *fakePool) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query")
}

func (p *fakePool) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}

func (p *fakePool) Ping(ctx context.Context) error {
	if p.pingFn == nil {
		return nil
	}
	return p.pingFn(ctx)
}

func (p *fakePool) Close() {
	p.closes.Add(1)
}

type fakeManagedTx struct {
	commitErr   error
	rollbackErr error
	commits     atomic.Int32
	rollbacks   atomic.Int32
}

type auditFailureTx struct {
	fakeManagedTx
	auditFailure   error
	businessWrites int
	auditWrites    int
}

type membershipAuditTx struct {
	arguments []any
}

func (t *membershipAuditTx) Exec(_ context.Context, _ string, arguments ...any) (pgconn.CommandTag, error) {
	t.arguments = append([]any(nil), arguments...)
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (t *membershipAuditTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query")
}

func (t *membershipAuditTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}

func (t *auditFailureTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	if strings.Contains(sql, "INSERT INTO feedback.audit_logs") {
		t.auditWrites++
		return pgconn.CommandTag{}, t.auditFailure
	}
	t.businessWrites++
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (t *fakeManagedTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	panic("unexpected Exec")
}

func (t *fakeManagedTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	panic("unexpected Query")
}

func (t *fakeManagedTx) QueryRow(context.Context, string, ...any) pgx.Row {
	panic("unexpected QueryRow")
}

func (t *fakeManagedTx) Commit(context.Context) error {
	t.commits.Add(1)
	return t.commitErr
}

func (t *fakeManagedTx) Rollback(context.Context) error {
	t.rollbacks.Add(1)
	return t.rollbackErr
}
