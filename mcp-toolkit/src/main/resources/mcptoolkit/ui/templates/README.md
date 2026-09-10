# Emitter templates

`ModUi.java.txt` is the vendored `<Mod>Ui.java` every generated mod carries (SCREEN_AUTHORING_DESIGN.md
section 7): `${package}` and `${class}` are filled in by `UiEmitter.vendor`. Its paint and widget bodies
are the interpreter's own (`ui/interp/Paint`, `LabelWidget`, `DecorWidget`, `DeclaredWidgets`), and
`UiEmitterTest` compares them body for body - edit one, edit the other, or the test says so.

`EntityMenus.java.txt` / `EntityMenuHost.java.txt` are the ui-kit slice-1 originals of the entity-fronted
menu factory (section 13's race: the open packet can arrive BEFORE the entity has synced, so the factory
hands the menu a NULL subject and the menu must tolerate it). Not emitted yet: the document has no
`subject` field until slice 7 gives it a real screen (rocketeer's `RocketMenu`). They are kept here, not
in a build root, so the contract survives without a jar nobody links.

**These two are the toolkit's only fabric-api dependency, and it is the CONSUMER's.** Both import
`net.fabricmc.fabric.api.menu.v1` (`ExtendedMenuType` / `ExtendedMenuProvider`), so a mod that takes
the entity-menu path pays a fabric-api dependency in its own build - priced out loud at generate
time by the emitter's report (SCREEN_AUTHORING_DESIGN.md section 7). The toolkit jar itself needs no
fabric-api, and nothing here is emitted until slice 7.
