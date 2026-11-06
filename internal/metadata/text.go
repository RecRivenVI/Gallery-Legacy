package metadata

import (
	"io"
	"strings"

	"golang.org/x/net/html"
)

// PlainText preserves paragraphs and decoded entities without rendering markup.
// Script/style contents are presentation code, not a description or search text.
func PlainText(source, format string) string {
	if format != "html" {
		return source
	}
	z := html.NewTokenizer(strings.NewReader(source))
	var result strings.Builder
	skip := 0
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if z.Err() == io.EOF {
				break
			}
			break
		}
		switch kind {
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			tag, _ := z.TagName()
			name := string(tag)
			if name == "script" || name == "style" {
				if kind == html.StartTagToken {
					skip++
				} else if kind == html.EndTagToken && skip > 0 {
					skip--
				}
			}
			if skip == 0 && strings.Contains("|p|br|div|li|ul|ol|h1|h2|h3|blockquote|tr|", "|"+name+"|") && result.Len() > 0 {
				result.WriteByte('\n')
			}
		case html.TextToken:
			if skip == 0 {
				result.Write(z.Text())
			}
		}
	}
	lines := strings.Split(result.String(), "\n")
	clean := lines[:0]
	for _, line := range lines {
		if line = strings.TrimSpace(line); line != "" {
			clean = append(clean, line)
		}
	}
	return strings.Join(clean, "\n")
}
