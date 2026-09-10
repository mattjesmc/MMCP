package com.mattmc.mcptoolkit.ui.doc;

import java.util.List;

/**
 * A document that could not be read, with EVERY problem found rather than the first.
 *
 * <p>The parser is also the lint: slice 5's {@code ui_doc op:"lint"} and the editor's inspector both
 * want the whole list, and a modder fixing a file wants it too. Each problem names a JSON path
 * ({@code elements[3].children[0].action}) so the fix is one lookup away.
 */
public final class UiParseException extends Exception {
    /** One problem at one path. */
    public record Problem(String path, String message) {
        @Override
        public String toString() {
            return path.isEmpty() ? message : path + ": " + message;
        }
    }

    private final List<Problem> problems;

    public UiParseException(final List<Problem> problems) {
        super(describe(problems));
        this.problems = List.copyOf(problems);
    }

    public List<Problem> problems() {
        return problems;
    }

    private static String describe(final List<Problem> problems) {
        StringBuilder sb = new StringBuilder();
        sb.append(problems.size()).append(problems.size() == 1 ? " problem" : " problems");
        for (Problem p : problems) {
            sb.append("\n  - ").append(p);
        }
        return sb.toString();
    }
}
