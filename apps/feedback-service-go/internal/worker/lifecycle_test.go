package worker

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunDrainsWorkThenWaitsUntilCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Options{
			PollInterval: time.Hour,
			OnError:      func(context.Context, error) { t.Error("unexpected error") },
		}, func(context.Context) (bool, error) {
			current := calls.Add(1)
			if current == 3 {
				cancel()
			}
			return current < 3, nil
		})
	}()
	select {
	case err := <-done:
		if err != nil || calls.Load() != 3 {
			t.Fatalf("Run() error=%v calls=%d", err, calls.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("context取消後にworkerが停止しません")
	}
}

func TestRunReportsTransientErrorAndRetries(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	var reported atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Options{
			PollInterval: time.Millisecond,
			OnError: func(_ context.Context, err error) {
				if !errors.Is(err, errTransient) {
					t.Errorf("reported error=%v", err)
				}
				reported.Add(1)
			},
		}, func(context.Context) (bool, error) {
			if calls.Add(1) == 1 {
				return false, errTransient
			}
			cancel()
			return false, nil
		})
	}()
	select {
	case err := <-done:
		if err != nil || calls.Load() != 2 || reported.Load() != 1 {
			t.Fatalf("Run() error=%v calls=%d reported=%d", err, calls.Load(), reported.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("workerが再試行しません")
	}
}

func TestRunDoesNotClaimAfterCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var calls atomic.Int32
	err := Run(ctx, Options{
		PollInterval: time.Second,
		OnError:      func(context.Context, error) { t.Error("unexpected error") },
	}, func(context.Context) (bool, error) {
		calls.Add(1)
		return false, nil
	})
	if err != nil || calls.Load() != 0 {
		t.Fatalf("Run() error=%v calls=%d", err, calls.Load())
	}
}

func TestRunStopsAtShutdownTimeoutWhenCycleIgnoresCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Options{
			PollInterval:    time.Hour,
			ShutdownTimeout: 20 * time.Millisecond,
			OnError:         func(context.Context, error) { t.Error("unexpected error") },
		}, func(context.Context) (bool, error) {
			close(started)
			<-release
			return false, nil
		})
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		close(release)
		if !errors.Is(err, ErrShutdownTimeout) {
			t.Fatalf("Run() error=%v", err)
		}
	case <-time.After(time.Second):
		close(release)
		t.Fatal("workerがshutdown timeout内に停止しません")
	}
}

func TestRunRejectsIncompleteOptions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		context context.Context
		options Options
		cycle   Cycle
	}{
		{name: "context", options: Options{PollInterval: time.Second, OnError: func(context.Context, error) {}}, cycle: func(context.Context) (bool, error) { return false, nil }},
		{name: "interval", context: context.Background(), options: Options{OnError: func(context.Context, error) {}}, cycle: func(context.Context) (bool, error) { return false, nil }},
		{name: "shutdown timeout", context: context.Background(), options: Options{PollInterval: time.Second, ShutdownTimeout: -1, OnError: func(context.Context, error) {}}, cycle: func(context.Context) (bool, error) { return false, nil }},
		{name: "observer", context: context.Background(), options: Options{PollInterval: time.Second}, cycle: func(context.Context) (bool, error) { return false, nil }},
		{name: "cycle", context: context.Background(), options: Options{PollInterval: time.Second, OnError: func(context.Context, error) {}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := Run(test.context, test.options, test.cycle); err == nil {
				t.Fatal("不完全な設定が受理されました")
			}
		})
	}
}

func TestRunGroupExecutesWorkersIndependently(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	backupStarted := make(chan struct{})
	var exportCalls atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- RunGroup(ctx,
			func(workerContext context.Context) error {
				return Run(workerContext, Options{
					PollInterval: time.Hour,
					OnError:      func(context.Context, error) { t.Error("unexpected backup error") },
				}, func(cycleContext context.Context) (bool, error) {
					close(backupStarted)
					<-cycleContext.Done()
					return false, cycleContext.Err()
				})
			},
			func(workerContext context.Context) error {
				return Run(workerContext, Options{
					PollInterval: time.Hour,
					OnError:      func(context.Context, error) { t.Error("unexpected export error") },
				}, func(context.Context) (bool, error) {
					<-backupStarted
					current := exportCalls.Add(1)
					if current == 3 {
						cancel()
					}
					return current < 3, nil
				})
			},
		)
	}()
	<-backupStarted
	select {
	case err := <-done:
		if err != nil || exportCalls.Load() != 3 {
			t.Fatalf("RunGroup() error=%v export calls=%d", err, exportCalls.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("backup処理中にexport workerが進行しません")
	}
}

func TestRunGroupTransientFailureDoesNotBlockOtherWorker(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	backupAttempted := make(chan struct{})
	var exportCalls atomic.Int32
	err := RunGroup(ctx,
		func(workerContext context.Context) error {
			return Run(workerContext, Options{
				PollInterval: time.Hour,
				OnError:      func(context.Context, error) {},
			}, func(context.Context) (bool, error) {
				close(backupAttempted)
				return false, errTransient
			})
		},
		func(workerContext context.Context) error {
			return Run(workerContext, Options{
				PollInterval: time.Hour,
				OnError:      func(context.Context, error) { t.Error("unexpected export error") },
			}, func(context.Context) (bool, error) {
				<-backupAttempted
				exportCalls.Add(1)
				cancel()
				return false, nil
			})
		},
	)
	if err != nil || exportCalls.Load() != 1 {
		t.Fatalf("RunGroup() error=%v export calls=%d", err, exportCalls.Load())
	}
}

func TestRunGroupPropagatesFailureAndStopsOtherWorkers(t *testing.T) {
	t.Parallel()
	otherStopped := make(chan struct{})
	err := RunGroup(context.Background(),
		func(context.Context) error { return errTransient },
		func(workerContext context.Context) error {
			<-workerContext.Done()
			close(otherStopped)
			return nil
		},
	)
	if !errors.Is(err, errTransient) {
		t.Fatalf("RunGroup() error=%v", err)
	}
	select {
	case <-otherStopped:
	default:
		t.Fatal("失敗時に他workerが停止していません")
	}
}

func TestRunGroupRejectsIncompleteRunners(t *testing.T) {
	t.Parallel()
	if err := RunGroup(nil, func(context.Context) error { return nil }); err == nil {
		t.Fatal("nil contextを受理しました")
	}
	if err := RunGroup(context.Background()); err == nil {
		t.Fatal("空のrunnerを受理しました")
	}
	if err := RunGroup(context.Background(), nil); err == nil {
		t.Fatal("nil runnerを受理しました")
	}
	if err := RunGroup(context.Background(), func(context.Context) error { return nil }); !errors.Is(err, ErrUnexpectedExit) {
		t.Fatalf("予期しない正常終了error=%v", err)
	}
}

var errTransient = errors.New("transient")
