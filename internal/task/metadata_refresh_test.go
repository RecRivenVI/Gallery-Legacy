package task

import (
	"context"
	"testing"
	"time"

	"github.com/RecRivenVI/Gallery-Legacy/internal/instance"
)

func TestMetadataRefreshYieldsToScanAndPreservesUserStop(t *testing.T) {
	config := instance.Config{StateRoot: t.TempDir(), LiveUpdates: true}
	refresh := NewMetadataRefresh(config)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := make(chan struct{}, 1)
	exit := make(chan struct{})
	go func() {
		defer close(exit)
		refresh.Run(ctx, func(work context.Context) func() {
			started <- struct{}{}
			<-work.Done()
			return func() {}
		})
	}()
	waitStart := func() {
		t.Helper()
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("metadata worker did not start")
		}
	}
	waitStart()
	if err := refresh.HoldForScan(ctx); err != nil {
		t.Fatal(err)
	}
	if state := refresh.Status().State; state != "WAITING_FOR_SCAN" {
		t.Fatal(state)
	}
	if _, err := refresh.Control("pause"); err != nil {
		t.Fatal(err)
	}
	refresh.ReleaseScan()
	if state := refresh.Status().State; state != "PAUSED" {
		t.Fatal(state)
	}
	if _, err := refresh.Control("resume"); err != nil {
		t.Fatal(err)
	}
	waitStart()
	if _, err := refresh.Control("cancel"); err != nil {
		t.Fatal(err)
	}
	if state := NewMetadataRefresh(config).Status().State; state != "CANCELLED" {
		t.Fatalf("user stop lost on restart: %s", state)
	}
	cancel()
	<-exit
}
