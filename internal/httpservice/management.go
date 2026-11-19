package httpservice

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/RecRivenVI/Gallery-Legacy/internal/media"

	"github.com/RecRivenVI/Gallery-Legacy/internal/dataset"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

// SnapshotState is used only by the authenticated local control owner.
func (s *Server) SnapshotState(ctx context.Context) (reading.Row, error) {
	s.dataGate.RLock()
	defer s.dataGate.RUnlock()
	state, err := s.state(ctx)
	if err != nil {
		return nil, err
	}
	state["thumbnails"], err = s.media.Cache.PreloadStatus(ctx)
	return state, err
}
func (s *Server) ReplaceDataset(next *dataset.Dataset) error {
	s.dataGate.Lock()
	defer s.dataGate.Unlock()
	previous := s.data
	s.media.Cache.SetScanning(true)
	s.data = next
	if next.Reader != nil {
		next.Reader.PersonalFile = s.people.File
	}
	s.media.Cache.SetScanning(false)
	return previous.Close()
}

func (s *Server) SetScanning(scanning bool) { s.media.Cache.SetScanning(scanning) }

func (s *Server) PauseCoversForMetadata(ctx context.Context) func() {
	return s.media.Cache.PauseForMetadata(ctx)
}

func (s *Server) QueueScannedCovers(ctx context.Context, platforms []string, author *string) error {
	s.media.Cache.SetScanning(false)
	request := media.PreloadRequest{Mode: "incremental", Platforms: platforms}
	if author != nil && len(platforms) == 1 {
		request.Authors = map[string][]string{platforms[0]: {*author}}
	}
	return s.media.Cache.QueueScannedCovers(ctx, request)
}
func (s *Server) Thumbnails(ctx context.Context, operation string, input reading.Row) (any, error) {
	if operation == "thumbnails.cancel" {
		if err := s.media.Cache.CancelPreload(); err != nil {
			return nil, err
		}
	}
	if operation == "thumbnails.start" {
		var request media.PreloadRequest
		b, err := json.Marshal(input)
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &request); err != nil {
			return nil, err
		}
		if err = s.media.Cache.StartPreloadTask(ctx, request); err != nil {
			return nil, err
		}
	}
	if operation == "thumbnails.pause" {
		paused, ok := input["paused"].(bool)
		if !ok {
			return nil, fmt.Errorf("INVALID_INPUT")
		}
		if err := s.media.Cache.PausePreload(paused); err != nil {
			return nil, err
		}
	}
	return s.media.Cache.PreloadStatus(ctx)
}
