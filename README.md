# MMCP — the `maven` branch

This branch is **not source**. It is a static Maven repository: the ordinary
`group/artifact/version` directory layout, committed as files, so that a Gradle build can resolve
the MCP Toolkit and its convention plugin over plain HTTPS with no repository server behind it.

The source is on `main`.

## What is here

| Coordinate | Version |
|---|---|
| `com.mattmc.mcptoolkit:mcp-toolkit` | 0.145.0 (jar, sources jar, pom, module metadata) |
| `com.mattmc.gradle:gradle-conventions` | 0.7.0 |
| `com.mattmc.mcmod` (plugin marker) | 0.7.0 |

Every artifact carries md5/sha1/sha256/sha512 beside it, written by Gradle's publisher.

## Using it

In `settings.gradle`, for the convention plugin:

```groovy
pluginManagement {
    repositories {
        maven { url = 'https://raw.githubusercontent.com/mattjesmc/MMCP/maven/' }
        gradlePluginPortal()
        maven { name = 'Fabric'; url = 'https://maven.fabricmc.net/' }
    }
}
```

and in `build.gradle`, for the toolkit itself:

```groovy
repositories {
    maven { url = 'https://raw.githubusercontent.com/mattjesmc/MMCP/maven/' }
}
dependencies {
    modImplementation 'com.mattmc.mcptoolkit:mcp-toolkit:0.145.0'
}
```

**While this repository is private that URL needs a credential**, because raw.githubusercontent.com
serves private content only to an authenticated request. Until it is public, the supported path is
the one `mcp-toolkit/README.md` describes: `gradlew publishToMavenLocal` in a checkout, and
`mavenLocal()` in the consumer. Nothing else about the consumer's build changes when the URL starts
working — it is one line swapped for another.

## How it is regenerated

Never by hand. From a workbench checkout, with this branch checked out somewhere:

```
mcp-toolkit/gradlew        publishAllPublicationsToStaticRepository -Pmaven_repo=<that checkout>
gradle-conventions/gradlew publishAllPublicationsToStaticRepository -Pmaven_repo=<that checkout>
```

Then commit what appears. A new version adds directories beside the old ones and rewrites each
artifact's `maven-metadata.xml`; nothing is deleted, so an old coordinate keeps resolving.

## License

The artifacts on this branch are **not MIT**. They are covered by the license in the `LICENSE` file
on `main`, and the mod jar carries a copy at `META-INF/LICENSE`. In short: free for non-commercial
use with nobody to ask, anything you author with it is yours, **commercial use needs permission
first**, and **the build is not to be redistributed** - link people to the repository rather than
re-hosting the jar. Resolving these coordinates in your own build is ordinary use and needs no
permission; mirroring this branch is redistribution and is not granted.

---

Not an official Minecraft product; not approved by or associated with Mojang.
