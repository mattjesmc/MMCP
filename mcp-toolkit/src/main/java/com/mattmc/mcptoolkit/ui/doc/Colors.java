package com.mattmc.mcptoolkit.ui.doc;

import java.util.Locale;

/** ARGB ints as the document writes them: {@code "#RRGGBB"} (opaque) or {@code "#AARRGGBB"}. */
public final class Colors {
    private Colors() {}

    /** Parse {@code #RRGGBB} or {@code #AARRGGBB}; six digits are taken as opaque. */
    public static int parse(final String s) {
        if (s == null || !s.startsWith("#") || (s.length() != 7 && s.length() != 9)) {
            throw new IllegalArgumentException("colour must be #RRGGBB or #AARRGGBB, got '" + s + "'");
        }
        long v;
        try {
            v = Long.parseLong(s.substring(1), 16);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("colour must be #RRGGBB or #AARRGGBB, got '" + s + "'");
        }
        if (s.length() == 7) {
            v |= 0xFF000000L;
        }
        return (int) v;
    }

    /** Always eight digits, upper case, so a written document has one spelling per colour. */
    public static String format(final int argb) {
        return String.format(Locale.ROOT, "#%08X", argb);
    }
}
