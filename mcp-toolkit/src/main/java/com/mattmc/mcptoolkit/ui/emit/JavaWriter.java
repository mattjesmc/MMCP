package com.mattmc.mcptoolkit.ui.emit;

/** An indenting line writer. Four spaces, LF, and the brace on the opening line - the workspace's style. */
final class JavaWriter {
    private final StringBuilder out = new StringBuilder();
    private int depth;

    JavaWriter line(final String s) {
        if (!s.isEmpty()) {
            out.append("    ".repeat(depth));
        }
        out.append(s).append('\n');
        return this;
    }

    JavaWriter blank() {
        out.append('\n');
        return this;
    }

    /** A line ending in {@code {}, then one level deeper. */
    JavaWriter open(final String s) {
        line(s.isEmpty() ? "{" : s + " {");
        depth++;
        return this;
    }

    /** Back one level and close the brace. */
    JavaWriter close() {
        depth--;
        return line("}");
    }

    /** Close with a trailing token: {@code });} or {@code };}. */
    JavaWriter close(final String suffix) {
        depth--;
        return line("}" + suffix);
    }

    /** A block comment / javadoc from plain lines. */
    JavaWriter doc(final String... lines) {
        line("/**");
        for (String l : lines) {
            line(l.isEmpty() ? " *" : " * " + l);
        }
        return line(" */");
    }

    @Override
    public String toString() {
        return out.toString();
    }
}
