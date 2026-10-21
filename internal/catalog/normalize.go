package catalog

import (
	"strings"
	"unicode"
)

// NormalizeQuery preserves the Node Reader's ECMAScript whitespace semantics.
// Stored Go index bytes retain their existing normalization contract.
func NormalizeQuery(s string) string {
	return strings.Join(strings.FieldsFunc(normalizedText(s), func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' }), " ")
}

// Equivalent to Join(Fields(s), " "), without a slice of every word. The
// common canonical case needs no allocation. Substrings preserve invalid UTF-8
// bytes exactly as Fields does; this is not a new text-cleaning policy.
func normalizeSpaces(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return s
	}
	space, rewrite := false, false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if r != ' ' || space {
				rewrite = true
			}
			space = true
		} else {
			space = false
		}
	}
	if !rewrite {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	start := -1
	for i, r := range s {
		if unicode.IsSpace(r) {
			if start >= 0 {
				if b.Len() > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(s[start:i])
				start = -1
			}
		} else if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		if b.Len() > 0 {
			b.WriteByte(' ')
		}
		b.WriteString(s[start:])
	}
	return b.String()
}
