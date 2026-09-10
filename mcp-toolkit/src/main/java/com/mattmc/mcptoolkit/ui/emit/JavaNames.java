package com.mattmc.mcptoolkit.ui.emit;

import java.util.Locale;
import java.util.Set;

/**
 * Document names to Java names. A document id is {@code [a-z][a-z0-9_]*} (the parser enforces it),
 * so every conversion here is total; the one thing that can go wrong is a Java keyword, and that
 * gets a trailing underscore rather than a refusal, so a button called {@code default} still emits.
 */
final class JavaNames {
    private JavaNames() {}

    private static final Set<String> KEYWORDS = Set.of(
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
        "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
        "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
        "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
        "volatile", "while", "true", "false", "null", "var", "record", "yield", "sealed", "permits");

    /** {@code fuel_max} to {@code FuelMax}. */
    static String pascal(final String s) {
        StringBuilder b = new StringBuilder();
        boolean up = true;
        for (char c : s.toCharArray()) {
            if (c == '_' || c == '-' || c == '.') {
                up = true;
            } else {
                b.append(up ? Character.toUpperCase(c) : c);
                up = false;
            }
        }
        return b.toString();
    }

    /** {@code fuel_max} to {@code fuelMax}. */
    static String camel(final String s) {
        String p = pascal(s);
        return p.isEmpty() ? p : Character.toLowerCase(p.charAt(0)) + p.substring(1);
    }

    /** {@code fuel_max} to {@code FUEL_MAX}. */
    static String constant(final String s) {
        return s.toUpperCase(Locale.ROOT);
    }

    /** A document id as a local variable or method-name fragment: itself, unless it is a keyword. */
    static String ident(final String s) {
        return KEYWORDS.contains(s) ? s + "_" : s;
    }

    /** A Java string literal, quoted and escaped. */
    static String str(final String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20 || c > 0x7E) {
                        b.append(String.format(Locale.ROOT, "\\u%04X", (int) c));
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.append('"').toString();
    }

    /** An ARGB int as {@code 0xAARRGGBB}. */
    static String argb(final int c) {
        return String.format(Locale.ROOT, "0x%08X", c);
    }

    /** A float literal. */
    static String flt(final float f) {
        return Float.toString(f) + "F";
    }
}
