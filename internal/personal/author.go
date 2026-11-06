package personal

import (
	"context"
	"fmt"
	"strings"

	"github.com/RecRivenVI/Gallery-Legacy/internal/reading"
)

func (s *Store) Link(ctx context.Context, left, right, action string) error {
	lp, lk, ok := reading.DecodePath(left)
	if !ok {
		return failure("INVALID_PATH")
	}
	rp, rk, ok := reading.DecodePath(right)
	if !ok {
		return failure("INVALID_PATH")
	}
	a, b := lp+":"+lk, rp+":"+rk
	if a == b {
		return failure("INVALID_PARAMETER")
	}
	if strings.Compare(a, b) > 0 {
		a, b = b, a
	}
	state := "linked"
	if action == "ignore" || action == "unlink" {
		state = "ignored"
	} else if action != "link" {
		return failure("INVALID_PARAMETER")
	}
	_, err := s.DB.ExecContext(ctx, "INSERT INTO author_links VALUES(?,?,?) ON CONFLICT(left_key,right_key) DO UPDATE SET state=excluded.state", a, b, state)
	if err != nil {
		return fmt.Errorf("change author association: %w", err)
	}
	return nil
}
