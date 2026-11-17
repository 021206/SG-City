#include "SGCityGameMode.h"

#include "Cesium3DTileset.h"
#include "Components/PrimitiveComponent.h"
#include "EngineUtils.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ProceduralMeshComponent.h"
#include "SGCityCameraPawn.h"
#include "SGCitySceneLoader.h"
#include "TimerManager.h"
#include "UnrealClient.h"

namespace
{
    constexpr float AutoShotTimeoutSeconds = 90.0f;
    constexpr float AutoShotSettleSeconds = 5.0f;
}

ASGCityGameMode::ASGCityGameMode()
{
    DefaultPawnClass = ASGCityCameraPawn::StaticClass();
}

void ASGCityGameMode::BeginPlay()
{
    Super::BeginPlay();

    bool bHasTileset = false;
    for (TActorIterator<ACesium3DTileset> It(GetWorld()); It; ++It)
    {
        bHasTileset = true;
        break;
    }

    if (!bHasTileset)
    {
        GetWorld()->SpawnActor<ASGCitySceneLoader>();
    }

    if (FParse::Param(FCommandLine::Get(), TEXT("SGCityAutoShot")))
    {
        bAutoShotEnabled = true;
        GetWorld()->GetTimerManager().SetTimer(
            AutoShotTimer, this, &ASGCityGameMode::TickAutoShot, 0.5f, true);
    }
}

void ASGCityGameMode::TickAutoShot()
{
    if (!bAutoShotEnabled || bAutoShotTaken)
    {
        return;
    }

    AutoShotElapsed += 0.5f;

    // Debug diagnostics: where are the camera and the tilesets?
    if (const APlayerController* PC = GetWorld()->GetFirstPlayerController())
    {
        const FVector CamLoc = PC->PlayerCameraManager
            ? PC->PlayerCameraManager->GetCameraLocation()
            : FVector::ZeroVector;
        const APawn* Pawn = PC->GetPawn();
        UE_LOG(LogTemp, Log,
            TEXT("SG-City diag: pawn=%s pawnLoc=(%.1f, %.1f, %.1f) camLoc=(%.1f, %.1f, %.1f)"),
            Pawn ? *Pawn->GetName() : TEXT("none"),
            Pawn ? Pawn->GetActorLocation().X : 0.0,
            Pawn ? Pawn->GetActorLocation().Y : 0.0,
            Pawn ? Pawn->GetActorLocation().Z : 0.0,
            CamLoc.X, CamLoc.Y, CamLoc.Z);

        // Physics trace from the camera to the world origin: Cesium tiles
        // cook real collision from the triangle data, so a hit proves the
        // meshes contain valid geometry.
        FHitResult Hit;
        const bool bHit = GetWorld()->LineTraceSingleByChannel(
            Hit, CamLoc, FVector(0.0, 0.0, 0.0), ECC_Visibility);
        UE_LOG(LogTemp, Log,
            TEXT("SG-City trace: hit=%d actor=%s component=%s dist=%.1f"),
            bHit ? 1 : 0,
            bHit && Hit.GetActor() ? *Hit.GetActor()->GetActorLabel() : TEXT("none"),
            bHit && Hit.GetComponent() ? *Hit.GetComponent()->GetName() : TEXT("none"),
            bHit ? Hit.Distance : -1.0);
    }

    float MinProgress = 100.0f;
    int32 TilesetCount = 0;
    for (TActorIterator<ACesium3DTileset> It(GetWorld()); It; ++It)
    {
        TilesetCount += 1;
        MinProgress = FMath::Min(MinProgress, It->GetLoadProgress());
        const FVector Loc = It->GetActorLocation();
        const FBox Bounds = It->GetComponentsBoundingBox(true);
        // Each rendered tile creates UCesiumGltfPrimitiveComponent instances
        // (UStaticMeshComponent subclasses in Cesium for Unreal 2.31).
        const int32 TileMeshes = It->K2_GetComponentsByClass(
            UStaticMeshComponent::StaticClass()).Num();
        UE_LOG(LogTemp, Log,
            TEXT("SG-City diag tileset %s: loc=(%.1f, %.1f, %.1f) tileMeshes=%d bounds=[%.0f..%.0f]x[%.0f..%.0f]x[%.0f..%.0f] progress=%.1f"),
            *It->GetActorLabel(), Loc.X, Loc.Y, Loc.Z, TileMeshes,
            Bounds.Min.X, Bounds.Max.X, Bounds.Min.Y, Bounds.Max.Y,
            Bounds.Min.Z, Bounds.Max.Z, It->GetLoadProgress());
        for (UActorComponent* Component : It->K2_GetComponentsByClass(
                 UStaticMeshComponent::StaticClass()))
        {
            const UStaticMeshComponent* Mesh = Cast<UStaticMeshComponent>(Component);
            if (!Mesh)
            {
                continue;
            }
            const FBoxSphereBounds MeshBounds = Mesh->Bounds;
            UE_LOG(LogTemp, Log,
                TEXT("SG-City diag mesh %s.%s: center=(%.0f, %.0f, %.0f) extent=(%.0f, %.0f, %.0f) visible=%d"),
                *It->GetActorLabel(), *Mesh->GetName(),
                MeshBounds.Origin.X, MeshBounds.Origin.Y, MeshBounds.Origin.Z,
                MeshBounds.BoxExtent.X, MeshBounds.BoxExtent.Y, MeshBounds.BoxExtent.Z,
                Mesh->IsVisible() ? 1 : 0);
        }
    }

    const bool bTimedOut = AutoShotElapsed >= AutoShotTimeoutSeconds;
    const bool bLoaded = TilesetCount > 0 && MinProgress >= 100.0f;

    if (!bTimedOut && !(bLoaded && AutoShotElapsed >= AutoShotSettleSeconds))
    {
        UE_LOG(LogTemp, Log,
            TEXT("SG-City auto shot: waiting (tilesets=%d progress=%.1f elapsed=%.1f)"),
            TilesetCount, MinProgress, AutoShotElapsed);
        return;
    }

    bAutoShotTaken = true;
    GetWorld()->GetTimerManager().ClearTimer(AutoShotTimer);

    UE_LOG(LogTemp, Log,
        TEXT("SG-City auto shot: capturing (tilesets=%d progress=%.1f elapsed=%.1f timedOut=%s)"),
        TilesetCount, MinProgress, AutoShotElapsed, bTimedOut ? TEXT("true") : TEXT("false"));

    if (GEngine && GEngine->GameViewport)
    {
        // Read back the actual presented frame to distinguish a capture-path
        // problem (FScreenshotRequest returning an empty buffer) from the
        // scene genuinely rendering black.
        TArray<FColor> Pixels;
        if (GEngine->GameViewport->Viewport
            && GEngine->GameViewport->Viewport->ReadPixels(Pixels))
        {
            int64 SumR = 0, SumG = 0, SumB = 0, NonZero = 0;
            for (const FColor& Pixel : Pixels)
            {
                SumR += Pixel.R;
                SumG += Pixel.G;
                SumB += Pixel.B;
                if (Pixel.R + Pixel.G + Pixel.B > 12)
                {
                    NonZero += 1;
                }
            }
            const int64 Count = Pixels.Num();
            UE_LOG(LogTemp, Log,
                TEXT("SG-City readback: %lld pixels avg=(%.2f, %.2f, %.2f) nonZero=%.2f%%"),
                Count,
                Count ? double(SumR) / Count : 0.0,
                Count ? double(SumG) / Count : 0.0,
                Count ? double(SumB) / Count : 0.0,
                Count ? 100.0 * NonZero / Count : 0.0);
        }
        else
        {
            UE_LOG(LogTemp, Warning, TEXT("SG-City readback: viewport ReadPixels failed"));
        }

        FScreenshotRequest::RequestScreenshot(TEXT("SGCityP0"), false, false);
        // Exit shortly after so headless verification runs terminate cleanly.
        FTimerHandle QuitTimer;
        GetWorld()->GetTimerManager().SetTimer(QuitTimer, []()
        {
            if (GEngine)
            {
                GEngine->Exec(nullptr, TEXT("Quit"));
            }
        }, 4.0f, false);
    }
}
