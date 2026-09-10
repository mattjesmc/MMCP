package com.mattmc.mcptoolkit.ui.emit;

import java.util.List;

/**
 * The emitter's output for one document: the files, and what the modder still has to do by hand -
 * the two registration lines, and anything priced out loud (section 11).
 */
public record Emission(EmitRequest request, List<GeneratedFile> files, List<String> notes) {
    public Emission {
        files = List.copyOf(files);
        notes = List.copyOf(notes);
    }

    public GeneratedFile file(final String simpleClassName) {
        for (GeneratedFile f : files) {
            if (f.path().endsWith("/" + simpleClassName + ".java")) {
                return f;
            }
        }
        return null;
    }
}
