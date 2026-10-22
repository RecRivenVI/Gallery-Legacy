// gallery-read is an explicit public-read integration entry, not a runtime owner.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"

	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/httpservice"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func run() error {
	config := flag.String("config", "", "explicit isolated instance configuration")
	frontend := flag.String("frontend", "", "public static root")
	assets := flag.String("assets", "", "prepared CanvasKit and font assets root")
	flag.Parse()
	if *config == "" || *frontend == "" || *assets == "" {
		return fmt.Errorf("config, frontend and assets are required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	d, err := dataset.Load(ctx, *config)
	if err != nil {
		return err
	}
	s, err := httpservice.New(d, httpservice.Options{Frontend: *frontend, Assets: *assets, Status: func() reading.Row { return reading.Row{"generations": []reading.Row{}, "liveUpdates": d.Live} }})
	if err != nil {
		d.Close()
		return err
	}
	defer s.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort(d.Config.Host, strconv.Itoa(d.Config.Port)))
	if err != nil {
		return err
	}
	host := &http.Server{Handler: s}
	done := make(chan error, 1)
	go func() { done <- host.Serve(listener) }()
	slog.Info("public read listener", "url", d.Config.URL)
	select {
	case <-ctx.Done():
		return host.Shutdown(context.Background())
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
func main() {
	if err := run(); err != nil {
		slog.Error("public read listener stopped", "error", err)
		os.Exit(1)
	}
}
