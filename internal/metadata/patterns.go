package metadata

import (
	"regexp"
)

var (
	integerPattern       = regexp.MustCompile(`^-?\d+$`)
	httpPattern          = regexp.MustCompile(`(?i)^https?://`)
	timezonePattern      = regexp.MustCompile(`(?i)(Z|[+-]\d{2}:?\d{2})$`)
	isolatedMonthPattern = regexp.MustCompile(`^[A-Za-z]+-(\d{1,2})Z$`)
	timestampPattern     = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})_(.+)$`)
	numericIDPattern     = regexp.MustCompile(`^\d+$`)
	uuidPattern          = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	secretQueryPattern   = regexp.MustCompile(`(?i)^(access_token|refresh_token|token|password|secret|cookie|authorization)$`)
	megaLinkPattern      = regexp.MustCompile(`(?i)https://mega(?:\.nz|\.co\.nz)/(?:file|folder)/`)
	adultRatingPattern   = regexp.MustCompile(`(?i)adult|r-?18`)
	topicPattern         = regexp.MustCompile(`#([^#\r\n]+)#`)
)
