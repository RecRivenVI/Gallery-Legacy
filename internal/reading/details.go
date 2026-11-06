package reading

import (
	"encoding/json"
	"fmt"

	"github.com/RecRivenVI/Gallery-Legacy/internal/metadata"
)

func (v *View) workDetails(workID int64) (metadata.Details, error) {
	details := metadata.Details{Tools: []string{}}
	if !v.live && !v.enriched {
		return details, nil
	}
	row, err := v.row("SELECT details_json FROM work_details WHERE work_id=?", workID)
	if err != nil {
		return details, err
	}
	if row != nil {
		if err = json.Unmarshal([]byte(text(row["details_json"])), &details); err != nil {
			return details, fmt.Errorf("read work details: %w", err)
		}
	}
	return details, nil
}
