package dataset

import (
	"context"
	"net/url"

	"github.com/RecRivenVI/Gallery-Legacy/internal/protocol"
	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func (d *Dataset) State(ctx context.Context) (reading.Row, error) {
	if d.Reader == nil {
		return reading.Row{"libraryReady": false, "counts": reading.Row{"works": 0, "authors": 0, "media": 0, "metadataStates": reading.Row{}}, "platformStats": []reading.Row{}}, nil
	}
	value, err := d.Reader.Snapshot(ctx, func(v *reading.View) (any, error) {
		counts, err := v.Stats()
		if err != nil {
			return nil, err
		}
		platforms, err := v.PlatformStats()
		if err != nil {
			return nil, err
		}
		result := reading.Row{"libraryReady": true, "counts": counts, "platformStats": platforms}
		if d.Live {
			state, err := v.LiveState()
			if err != nil {
				return nil, err
			}
			result["live"] = state
		}
		return result, nil
	})
	if err != nil {
		return nil, err
	}
	return value.(reading.Row), nil
}

func (d *Dataset) Page(ctx context.Context, kind string, params url.Values) (reading.Row, error) {
	if d.Reader == nil {
		q, err := protocol.ParseQuery(params, kind, d.Epoch, nil)
		if err != nil {
			return nil, err
		}
		return reading.Row{"items": []reading.Row{}, "total": 0, "page": q.Page, "pageSize": q.PageSize, "totalPages": 1, "cursor": nil, "mode": kind}, nil
	}
	value, err := d.Reader.Snapshot(ctx, func(v *reading.View) (any, error) {
		var revision *int64
		if d.Live {
			state, err := v.LiveState()
			if err != nil {
				return nil, err
			}
			revision = &state.Revision
		}
		return v.Page(kind, params, revision)
	})
	if err != nil {
		return nil, err
	}
	return value.(reading.Row), nil
}
