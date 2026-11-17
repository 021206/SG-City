"""Create the Marina Bay P0 level inside Unreal Editor.

Run with UnrealEditor-Cmd after installing UE 5.8 and Cesium for Unreal 2.31.0:
UnrealEditor-Cmd.exe "E:\\SG-City\\SGCity.uproject" -run=pythonscript -script="E:\\SG-City\\Tools\\unreal\\setup_scene.py"
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import unreal

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_ROOT = PROJECT_ROOT / "LocalData" / "SGCityData"
MAP_PATH = "/Game/Maps/L_MarinaBay_P0"


def file_url(path: Path) -> str:
    value = path.resolve().as_posix()
    return "file:///" + quote(value, safe="/:")


def enum_member(enum_type: object, *names: str) -> object:
    for name in names:
        if hasattr(enum_type, name):
            return getattr(enum_type, name)
    raise AttributeError(f"None of {names} exists on {enum_type}")


def find_enum_type(*names: str) -> object:
    """Resolve a UENUM exposed to Python.

    UE Python strips the leading "E" prefix from C++ enum names, so
    ETilesetSource is exposed as ``unreal.TilesetSource``. Try the given
    candidates first, then fall back to a dir() scan so the script keeps
    working across UE / plugin versions.
    """
    for name in names:
        candidate = getattr(unreal, name, None)
        if candidate is not None:
            return candidate
    keyword = names[-1].replace("E", "", 1).lower()
    matches = [name for name in dir(unreal) if keyword in name.lower()]
    if len(matches) == 1:
        return getattr(unreal, matches[0])
    raise AttributeError(
        f"Could not resolve enum from {names}; dir(unreal) candidates: {matches}"
    )


def call_first(actor: unreal.Actor, names: tuple[str, ...], *args: object) -> None:
    for name in names:
        method = getattr(actor, name, None)
        if callable(method):
            method(*args)
            return
    raise AttributeError(f"None of {names} exists on {actor}")


def cleanup_level(actor_subsystem: unreal.EditorActorSubsystem) -> None:
    """Remove all SG-City and Cesium actors so re-runs never duplicate them."""
    for actor in actor_subsystem.get_all_level_actors():
        class_name = actor.get_class().get_name()
        label = actor.get_actor_label()
        managed = (
            label.startswith("SGCity_")
            or class_name == "Cesium3DTileset"
            or class_name == "CesiumGeoreference"
            or class_name == "CesiumCameraManager"
            or class_name.startswith("CesiumCreditSystem")
        )
        if managed:
            actor_subsystem.destroy_actor(actor)


def spawn(actor_subsystem: unreal.EditorActorSubsystem, class_object: object, label: str) -> unreal.Actor:
    actor = actor_subsystem.spawn_actor_from_class(
        class_object,
        unreal.Vector(0.0, 0.0, 0.0),
        unreal.Rotator(0.0, 0.0, 0.0),
    )
    if actor is None:
        raise RuntimeError(f"Failed to spawn {label}")
    actor.set_actor_label(label)
    return actor


def create_or_open_level() -> None:
    package_path = f"{MAP_PATH}.{MAP_PATH.rsplit('/', 1)[-1]}"
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if unreal.EditorAssetLibrary.does_asset_exist(package_path):
        if not level_subsystem.load_level(MAP_PATH):
            raise RuntimeError(f"Failed to load level: {MAP_PATH}")
    else:
        if not level_subsystem.new_level(MAP_PATH):
            raise RuntimeError(f"Failed to create level: {MAP_PATH}")


def configure_world() -> None:
    editor_subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
    world = editor_subsystem.get_editor_world()
    settings = world.get_world_settings()
    game_mode = getattr(unreal, "SGCityGameMode", None)
    if game_mode is not None:
        settings.set_editor_property("default_game_mode", game_mode)
    # Cesium tilesets span large world coordinates; bounds checks must be off.
    try:
        settings.set_editor_property("bEnableWorldBoundsChecks", False)
    except Exception as exc:
        unreal.log_warning(f"SG-City could not disable world bounds checks: {exc}")


def set_first_property(obj: object, names: tuple[str, ...], value: object, label: str) -> bool:
    """set_editor_property with name fallbacks for cross-version robustness."""
    for name in names:
        try:
            obj.set_editor_property(name, value)  # type: ignore[attr-defined]
            return True
        except Exception:
            continue
    unreal.log_warning(f"SG-City: none of {names} worked for {label}")
    return False


def configure_lighting(actor_subsystem: unreal.EditorActorSubsystem) -> None:
    sun = spawn(actor_subsystem, unreal.DirectionalLight, "SGCity_MoonKey")
    sun.set_actor_rotation(unreal.Rotator(-62.0, 28.0, 0.0), False)
    light_component = sun.get_component_by_class(unreal.LightComponent)
    # TEMP diagnostic: very bright light to rule out lighting/exposure as
    # the cause of a black verification screenshot. Tune down once visuals
    # are confirmed (target: ~0.18 lux moonlight for the night look).
    light_component.set_editor_property("intensity", 10.0)
    light_component.set_editor_property("light_color", unreal.Color(120, 190, 190, 255))

    sky = spawn(actor_subsystem, unreal.SkyAtmosphere, "SGCity_NightAtmosphere")
    sky.set_actor_scale3d(unreal.Vector(1.0, 1.0, 1.0))

    fog = spawn(actor_subsystem, unreal.ExponentialHeightFog, "SGCity_HarborFog")
    fog_component = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    fog_component.set_editor_property("fog_density", 0.000012)
    # UE5 renamed InscatteringColor -> FogInscatteringLuminance (linear color).
    # Dark teal harbor night: sRGB(4, 38, 42) converted to linear.
    fog_component.set_editor_property(
        "fog_inscattering_luminance",
        unreal.LinearColor(0.0007, 0.0167, 0.0208, 1.0),
    )

    post = spawn(actor_subsystem, unreal.PostProcessVolume, "SGCity_NightPostProcess")
    set_first_property(post, ("bUnbound", "unbound", "infinite_extent_unbound"), True, "post unbound")
    settings = post.get_editor_property("settings")
    try:
        # Raw C++ property names (bOverride_Xxx / Xxx) work via
        # set_editor_property on UStruct instances across UE versions.
        settings.set_editor_property("bOverride_BloomIntensity", True)
        settings.set_editor_property("BloomIntensity", 1.6)
        settings.set_editor_property("bOverride_AutoExposureMethod", True)
        settings.set_editor_property("AutoExposureMethod", unreal.AutoExposureMethod.AEM_MANUAL)
        settings.set_editor_property("bOverride_AutoExposureMinBrightness", True)
        settings.set_editor_property("bOverride_AutoExposureMaxBrightness", True)
        settings.set_editor_property("AutoExposureMinBrightness", 8.0)
        settings.set_editor_property("AutoExposureMaxBrightness", 8.0)
        post.set_editor_property("settings", settings)
    except Exception as exc:  # UE property names can differ across minor versions.
        unreal.log_warning(f"SG-City post-process defaults were not fully applied: {exc}")


def main() -> None:
    manifest_path = DATA_ROOT / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Run npm run data:p0 first: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    create_or_open_level()
    configure_world()
    actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    cleanup_level(actor_subsystem)

    georeference = spawn(actor_subsystem, unreal.CesiumGeoreference, "SGCity_Georeference")
    origin = manifest["origin"]
    call_first(
        georeference,
        ("set_origin_longitude_latitude_height", "SetOriginLongitudeLatitudeHeight"),
        unreal.Vector(origin["longitude"], origin["latitude"], origin["height"]),
    )

    tileset_source_enum = find_enum_type("TilesetSource", "ETilesetSource")
    source = enum_member(tileset_source_enum, "FROM_URL", "FROMURL")
    for layer in manifest["layers"]:
        entry = DATA_ROOT / layer["entry"]
        actor = spawn(actor_subsystem, unreal.Cesium3DTileset, f"SGCity_{layer['id']}")
        # SetTilesetSource / SetUrl are BlueprintSetter meta only (not
        # UFUNCTIONs), so they are not callable from Python. Set the
        # underlying editor properties instead.
        actor.set_editor_property("tileset_source", source)
        actor.set_editor_property("url", file_url(entry))
        # Bind the tileset to OUR georeference explicitly; otherwise the
        # plugin resolves "the first georeference in the world", which may
        # be one it auto-spawned with a default (Colorado) origin.
        actor.set_editor_property("georeference", georeference)
        if not layer.get("visible", True):
            try:
                actor.set_actor_hidden_in_game(True)
            except Exception as exc:
                unreal.log_warning(f"SG-City could not hide layer {layer['id']}: {exc}")

    # Remove the auto-spawned duplicate georeference (default Colorado
    # origin) that the Cesium editor plugin creates alongside tilesets.
    for actor in actor_subsystem.get_all_level_actors():
        if (
            actor.get_class().get_name() == "CesiumGeoreference"
            and actor.get_actor_label() != "SGCity_Georeference"
        ):
            actor_subsystem.destroy_actor(actor)

    configure_lighting(actor_subsystem)
    level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    level_subsystem.save_current_level()
    unreal.EditorAssetLibrary.save_directory("/Game/Maps", only_if_is_dirty=True)
    unreal.log(f"SG-City P0 level created from {manifest_path}")


if __name__ == "__main__":
    main()
