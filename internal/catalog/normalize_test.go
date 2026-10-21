package catalog

import (
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"math/rand"
	"strings"
	"testing"
)

func referenceNormalize(s string) string {
	s = norm.NFKC.String(s)
	if strings.ContainsAny(s, "\u200b\u200c\u200d\u200e\u200f\u2060\ufeff") {
		s = invisible.ReplaceAllString(s, "")
	}
	if strings.Contains(s, "<") {
		s = markup.ReplaceAllString(s, " ")
	}
	if strings.Contains(s, "&") {
		s = namedEntity.ReplaceAllStringFunc(s, decodeNamedEntity)
	}
	if strings.Contains(s, "&#") {
		s = numericEntity.ReplaceAllStringFunc(s, decodeNumericEntity)
	}
	s = cases.Lower(language.Und).String(s)
	return strings.Join(strings.Fields(s), " ")
}

func TestNormalizeSpacesMatchesExistingSearchBytes(t *testing.T) {
	seeds := []string{"", "a", "a b", " a  b ", "a\t\r\nb", "\u0085中文\u3000日本語\u00a0", "👋🏾 emoji", "العربية עברית", "<b>&amp; &#x200b; &#160;</b>", string([]byte{0xff, 'a', ' ', 0xc3, 0x28, '\t', 'b'})}
	for _, s := range seeds {
		if got, want := normalizeSpaces(s), strings.Join(strings.Fields(s), " "); got != want {
			t.Fatalf("space bytes changed: %x != %x", got, want)
		}
		if got, want := Normalize(s), referenceNormalize(s); got != want {
			t.Fatalf("search bytes changed: %x != %x", got, want)
		}
	}
	rng := rand.New(rand.NewSource(20261018))
	alphabet := []string{"a", "Z", "中", "日", "👋", "\u0301", "\u200b", "\u200f", "&amp;", "&#160;", "<b>", " ", "\t", "\n", "\r", "\v", "\f", "\u0085", "\u00a0", "\u1680", "\u2007", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", string([]byte{0xff}), string([]byte{0xc3})}
	for n := 0; n < 10000; n++ {
		var b strings.Builder
		for k := rng.Intn(80); k > 0; k-- {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		s := b.String()
		if got, want := normalizeSpaces(s), strings.Join(strings.Fields(s), " "); got != want {
			t.Fatalf("space property changed: %x != %x", got, want)
		}
		if got, want := Normalize(s), referenceNormalize(s); got != want {
			t.Fatalf("search property changed: %x != %x", got, want)
		}
	}
}

var normalizedBenchmarkSink string

func TestQueryWhitespaceKeepsExistingNodeSearchMeaning(t *testing.T) {
	for _, test := range []struct{ input, want string }{{"\u0085", "\u0085"}, {"a\u0085b", "a\u0085b"}, {" &#xFEFF; ", ""}, {"A\u00A0B", "a b"}} {
		if got := NormalizeQuery(test.input); got != test.want {
			t.Fatalf("query %q: %q != %q", test.input, got, test.want)
		}
	}
}

func TestCanonicalAndEmptySpaceNormalizationDoNotAllocate(t *testing.T) {
	for _, s := range []string{"synthetic 中文 title", strings.Repeat(" \t\n\u0085", 1024), "\t" + strings.Repeat("synthetic 中文 title ", 128) + "\n"} {
		if n := testing.AllocsPerRun(100, func() { normalizedBenchmarkSink = normalizeSpaces(s) }); n != 0 {
			t.Fatal("avoidable allocation", n)
		}
	}
}
func BenchmarkNormalizeSpaces(b *testing.B) {
	for _, input := range []struct{ name, text string }{{"canonical", "synthetic 中文 title"}, {"body", strings.Repeat("synthetic 中文 abstract ", 128)}, {"mixed", " \u0085中文\u3000日本語\t\tEnglish\n\n"}} {
		for _, reference := range []bool{true, false} {
			name := "stream"
			if reference {
				name = "fields"
			}
			b.Run(input.name+"/"+name, func(b *testing.B) {
				b.ReportAllocs()
				for n := 0; n < b.N; n++ {
					if reference {
						normalizedBenchmarkSink = strings.Join(strings.Fields(input.text), " ")
					} else {
						normalizedBenchmarkSink = normalizeSpaces(input.text)
					}
				}
			})
		}
	}
}
