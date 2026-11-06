package httpservice

import (
	"context"
	"net/url"
)

func (s *Server) previews(ctx context.Context, value any) error {
	switch item := value.(type) {
	case map[string]any:
		if address, ok := item["thumbnailUrl"].(string); ok {
			u, err := url.Parse(address)
			if err != nil {
				return err
			}
			if key := u.Query().Get("v"); key != "" {
				summary, err := s.media.Cache.LookupSummary(ctx, key)
				if err != nil {
					return err
				}
				for name, v := range summary {
					item[name] = v
				}
			}
		}
		for _, v := range item {
			if err := s.previews(ctx, v); err != nil {
				return err
			}
		}
	case []map[string]any:
		for _, v := range item {
			if err := s.previews(ctx, v); err != nil {
				return err
			}
		}
	case []any:
		for _, v := range item {
			if err := s.previews(ctx, v); err != nil {
				return err
			}
		}
	}
	return nil
}
