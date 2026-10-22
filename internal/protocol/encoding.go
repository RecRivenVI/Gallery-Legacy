package protocol

import (
	"net/url"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// JSON preserves JSON.stringify string escaping for public hashes and bodies.
func JSON(value any) ([]byte, error) { return stringify(value) }

// Lower preserves JavaScript's contextual Unicode lowercasing in identities.
func Lower(value string) string { return cases.Lower(language.Und).String(value) }

func TrimSpace(value string) string {
	return strings.TrimFunc(value, func(r rune) bool { return unicode.IsSpace(r) && r != '\u0085' || r == '\ufeff' })
}

func Component(value string) string {
	var b strings.Builder
	const hex = "0123456789ABCDEF"
	for _, c := range []byte(value) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.!~*'()", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}
func FormComponent(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(url.QueryEscape(value), "~", "%7E"), "%2A", "*")
}
