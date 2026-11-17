#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "SGCityGameMode.generated.h"

UCLASS()
class SGCITY_API ASGCityGameMode : public AGameModeBase
{
    GENERATED_BODY()

public:
    ASGCityGameMode();
    virtual void BeginPlay() override;

private:
    /** Polls Cesium tileset load progress and captures a screenshot once
     *  everything is loaded (or after a timeout). Enabled with
     *  -SGCityAutoShot on the command line; used for headless verification. */
    void TickAutoShot();

    bool bAutoShotEnabled = false;
    bool bAutoShotTaken = false;
    float AutoShotElapsed = 0.0f;
    FTimerHandle AutoShotTimer;
};
