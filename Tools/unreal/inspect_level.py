"""Inspect the P0 level: list actors and verify Cesium tileset configuration.

Run:
UnrealEditor-Cmd.exe "E:\\SG-City\\SGCity.uproject" -run=pythonscript -script="E:\\SG-City\\Tools\\unreal\\inspect_level.py"
"""

from __future__ import annotations

import unreal

MAP_PATH = "/Game/Maps/L_MarinaBay_P0"


def main() -> None:
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not level_subsystem.load_level(MAP_PATH):
        raise RuntimeError(f"Failed to load level: {MAP_PATH}")

    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    actors = actor_subsystem.get_all_level_actors()

    unreal.log(f"SG-City inspect: {len(actors)} actors in {MAP_PATH}")
    for actor in actors:
        label = actor.get_actor_label()
        class_name = actor.get_class().get_name()
        location = actor.get_actor_location()
        extra = ""
        if class_name == "Cesium3DTileset":
            try:
                extra = (
                    f" source={actor.get_editor_property('tileset_source')}"
                    f" url={actor.get_editor_property('url')}"
                )
            except Exception as exc:
                extra = f" (property read failed: {exc})"
        elif class_name == "CesiumGeoreference":
            try:
                extra = (
                    f" lon={actor.get_editor_property('origin_longitude')}"
                    f" lat={actor.get_editor_property('origin_latitude')}"
                    f" h={actor.get_editor_property('origin_height')}"
                )
            except Exception as exc:
                extra = f" (property read failed: {exc})"
        unreal.log(
            f"SG-City actor: {label} ({class_name})"
            f" loc=({location.x:.1f}, {location.y:.1f}, {location.z:.1f}){extra}"
        )

    # Also check world settings.
    editor_subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
    world = editor_subsystem.get_editor_world()
    settings = world.get_world_settings()
    mode = settings.get_editor_property("default_game_mode")
    unreal.log(f"SG-City world: default_game_mode={mode.get_name() if mode else None}")


if __name__ == "__main__":
    main()
