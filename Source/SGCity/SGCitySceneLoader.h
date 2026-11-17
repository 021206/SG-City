#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SGCitySceneLoader.generated.h"

class ACesium3DTileset;

UCLASS()
class SGCITY_API ASGCitySceneLoader : public AActor
{
    GENERATED_BODY()

public:
    ASGCitySceneLoader();
    virtual void BeginPlay() override;

    UFUNCTION(BlueprintCallable, Category = "SG City")
    bool LoadScene();

    UFUNCTION(BlueprintCallable, Category = "SG City")
    bool SetLayerVisible(FName LayerId, bool bVisible);

    UFUNCTION(BlueprintPure, Category = "SG City")
    FString GetResolvedDataRoot() const { return ResolvedDataRoot; }

private:
    UPROPERTY(EditAnywhere, Category = "SG City")
    FString DataRootOverride;

    UPROPERTY(Transient)
    TMap<FName, TObjectPtr<ACesium3DTileset>> LayerActors;

    FString ResolvedDataRoot;
};
