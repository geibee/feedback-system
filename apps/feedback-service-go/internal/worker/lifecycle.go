// Package worker は全worker roleで共有するpollingと安全停止の境界を提供する。
package worker

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Cycle は1件のclaimまたは定期処理を実行し、直ちに次件を処理すべきときworked=trueを返す。
type Cycle func(context.Context) (worked bool, err error)

// Options はworker loopの共通設定である。
type Options struct {
	PollInterval    time.Duration
	ShutdownTimeout time.Duration
	OnError         func(context.Context, error)
}

const MaximumShutdownTimeout = 30 * time.Second

var ErrShutdownTimeout = errors.New("worker graceful shutdownがtimeoutしました")

var ErrUnexpectedExit = errors.New("worker loopが予期せず終了しました")

type cycleResult struct {
	worked bool
	err    error
}

// Run はcontext取消後に新規claimを開始せず、待機中も即座に停止する。
// cycleの一時errorは記録してpoll interval後に再試行し、process自体は終了させない。
func Run(ctx context.Context, options Options, cycle Cycle) error {
	if ctx == nil {
		return errors.New("worker contextが未設定です")
	}
	if options.PollInterval <= 0 {
		return errors.New("worker poll intervalは正数で指定してください")
	}
	if options.ShutdownTimeout < 0 {
		return errors.New("worker shutdown timeoutは0以上で指定してください")
	}
	if options.ShutdownTimeout == 0 {
		options.ShutdownTimeout = MaximumShutdownTimeout
	}
	if options.OnError == nil {
		return errors.New("worker error observerが未設定です")
	}
	if cycle == nil {
		return errors.New("worker cycleが未設定です")
	}

	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		cycleDone := make(chan cycleResult, 1)
		go func() {
			worked, err := cycle(ctx)
			cycleDone <- cycleResult{worked: worked, err: err}
		}()
		var result cycleResult
		select {
		case result = <-cycleDone:
		case <-ctx.Done():
			timer := time.NewTimer(options.ShutdownTimeout)
			select {
			case <-cycleDone:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				return nil
			case <-timer.C:
				return ErrShutdownTimeout
			}
		}
		worked, err := result.worked, result.err
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			options.OnError(ctx, fmt.Errorf("worker cycleに失敗しました: %w", err))
		}
		if err == nil && worked {
			continue
		}
		if err := wait(ctx, options.PollInterval); err != nil {
			return nil
		}
	}
}

// RunGroup は複数のworker loopを並行実行し、いずれかの終了時に残りを安全停止する。
// 親contextの取消前にloopが正常終了した場合は、予期しない終了としてprocessへ伝播する。
func RunGroup(ctx context.Context, runners ...func(context.Context) error) error {
	if ctx == nil {
		return errors.New("worker group contextが未設定です")
	}
	if len(runners) == 0 {
		return errors.New("worker group runnerが未設定です")
	}
	for _, runner := range runners {
		if runner == nil {
			return errors.New("worker group runnerが未設定です")
		}
	}

	groupContext, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, len(runners))
	for _, runner := range runners {
		go func() {
			results <- runner(groupContext)
		}()
	}

	var failures []error
	for index := 0; index < len(runners); index++ {
		err := <-results
		if index == 0 {
			if err == nil && ctx.Err() == nil {
				err = ErrUnexpectedExit
			}
			cancel()
		}
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
