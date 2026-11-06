package searchquery

import "testing"

func TestSyntaxAndOriginalOffsets(t *testing.T) {
	input := `雨 "初音 未来" -标签：AI title:风景 平台:p,微 unknown:value`
	terms := Parse(input)
	want := [][2]string{{"any", "雨"}, {"any", "初音 未来"}, {"tag", "AI"}, {"title", "风景"}, {"platform", "p,微"}, {"any", "unknown:value"}}
	if len(terms) != len(want) {
		t.Fatalf("terms: %#v", terms)
	}
	for i, term := range terms {
		if term.Field != want[i][0] || term.Value != want[i][1] || input[term.Start:term.End] != term.Raw {
			t.Fatalf("token %d: %#v", i, term)
		}
	}
	if !terms[2].Exclude {
		t.Fatal("exclusion lost")
	}
	if got := Selected(terms); len(got) != 2 || got[0] != "pixiv" || got[1] != "微博" {
		t.Fatalf("platforms %v", got)
	}
	bad := `标题:"没有结束 空格`
	literal := Parse(bad)
	if len(literal) != 1 || literal[0].Field != "any" || literal[0].Value != bad {
		t.Fatalf("unbalanced quote %#v", literal)
	}
	if Platform("F") != "Fantia" || Platform("f") != "pixivFANBOX" || Platform("P") != "Patreon" || Platform("p") != "pixiv" {
		t.Fatal("case-sensitive badges")
	}
}
