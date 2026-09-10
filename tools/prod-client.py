r"""Build a launcher-less PRODUCTION Minecraft client command from an installed launcher version.

Why this exists: every client boot up to §16 of mcp-toolkit/docs/platform/CROSS_LOADER_DESIGN.md was a Gradle
runClient, so `Platform.isDevelopment()` had never taken its production arm on a client. The obvious
cell — put the jar in %APPDATA%\.minecraft\mods and press Play — needs a human at the launcher GUI
and puts a test jar in the user's real game. This assembles the same launch the launcher would, out
of the version JSON the launcher already installed, into a THROWAWAY game dir:

    python tools/prod-client.py --game-dir run/prod-client
    java @<scratch>/client_args.txt          # or whatever --out says

Offline session (accessToken 0): singleplayer works, and the two authlib 401s in the log
(/player/attributes, /player/certificates) are that, not a fault. Libraries, assets and the vanilla
jar are shared from .minecraft; only mods/, config/, saves/ and logs/ live in the game dir.
"""
import argparse, json, os, sys

def load(mc, v):
    with open(os.path.join(mc, "versions", v, v + ".json"), encoding="utf-8") as f:
        return json.load(f)

def rules_ok(rules):
    """Evaluate a launcher rule list for windows/x64 with no optional features enabled."""
    if not rules:
        return True
    allowed = False
    for r in rules:
        match = True
        osr = r.get("os")
        if osr:
            if "name" in osr and osr["name"] != "windows":
                match = False
            if "arch" in osr and osr["arch"] != "x64":
                match = False
        if "features" in r:  # is_demo_user, has_custom_resolution, quickPlay — none of them
            match = False
        if match:
            allowed = r["action"] == "allow"
    return allowed

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--mc", default=os.path.expandvars(r"%APPDATA%\.minecraft"))
    p.add_argument("--version", default="fabric-loader-0.19.3-26.2")
    p.add_argument("--game-dir", required=True)
    p.add_argument("--user", default="ProdCell")
    p.add_argument("--out", default="client_args.txt")
    p.add_argument("--xmx", default="3G")
    a = p.parse_args()

    gamedir = os.path.abspath(a.game_dir)
    child = load(a.mc, a.version)
    parent = load(a.mc, child["inheritsFrom"]) if "inheritsFrom" in child else child

    cp, seen, missing = [], set(), []
    for lib in child.get("libraries", []) + parent["libraries"]:
        if not rules_ok(lib.get("rules")):
            continue
        art = lib.get("downloads", {}).get("artifact")
        if art and art.get("path"):
            path = os.path.join(a.mc, "libraries", art["path"].replace("/", os.sep))
        else:
            g, n, v = lib["name"].split(":")[:3]
            path = os.path.join(a.mc, "libraries", *g.split("."), n, v, f"{n}-{v}.jar")
        # Fabric's own libraries duplicate vanilla's by basename at different versions; first wins,
        # and the loader's list comes first on purpose.
        if os.path.basename(path) in seen:
            continue
        seen.add(os.path.basename(path))
        (cp if os.path.exists(path) else missing).append(path)
    if missing:
        print("missing libraries (open the launcher once for this version):", file=sys.stderr)
        for m in missing:
            print("  " + m, file=sys.stderr)
        return 1
    cp.append(os.path.join(a.mc, "versions", parent["id"], parent["id"] + ".jar"))

    jvm = list(child.get("arguments", {}).get("jvm", []))
    for arg in parent["arguments"]["jvm"]:
        if isinstance(arg, str):
            jvm.append(arg)
        elif rules_ok(arg.get("rules")):
            v = arg["value"]
            jvm += v if isinstance(v, list) else [v]
    game = [x for x in parent["arguments"]["game"] if isinstance(x, str)]

    subs = {
        "${natives_directory}": os.path.join(gamedir, "natives"),
        "${launcher_name}": "prod-client-cell", "${launcher_version}": "1",
        "${classpath}": os.pathsep.join(cp),
        "${auth_player_name}": a.user, "${version_name}": a.version,
        "${game_directory}": gamedir, "${assets_root}": os.path.join(a.mc, "assets"),
        "${assets_index_name}": parent["assetIndex"]["id"],
        "${auth_uuid}": "1111111111114111811111111111111a",
        "${auth_access_token}": "0", "${clientid}": "0", "${auth_xuid}": "0",
        "${version_type}": parent["type"],
    }
    def sub(s):
        for k, v in subs.items():
            s = s.replace(k, v)
        return s
    args = ["-Xmx" + a.xmx] + [sub(x) for x in jvm] \
        + [child.get("mainClass") or parent["mainClass"]] + [sub(x) for x in game]

    # java's @argfile: one arg per line, backslashes escaped (a bare Windows path is read as escapes).
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join('"' + x.replace("\\", "\\\\").replace('"', '\\"') + '"' for x in args))
    print(f"{a.out}: {len(cp)} libs, main {args[len(args) - len(game) - 1]}, gameDir {gamedir}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
