#include "SGCitySceneLoader.h"

#include "Cesium3DTileset.h"
#include "CesiumGeoreference.h"
#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "SGCityData.h"

ASGCitySceneLoader::ASGCitySceneLoader()
{
    PrimaryActorTick.bCanEverTick = false;
}

void ASGCitySceneLoader::BeginPlay()
{
    Super::BeginPlay();
    LoadScene();
}

bool ASGCitySceneLoader::LoadScene()
{
    ResolvedDataRoot = DataRootOverride.IsEmpty()
        ? SGCityData::FindDataRoot()
        : FPaths::ConvertRelativePathToFull(DataRootOverride);

    FString ManifestText;
    const FString ManifestPath = SGCityData::GetManifestPath(ResolvedDataRoot);
    if (!FFileHelper::LoadFileToString(ManifestText, *ManifestPath))
    {
        UE_LOG(LogTemp, Error, TEXT("SG-City manifest not found: %s"), *ManifestPath);
        if (GEngine)
        {
            GEngine->AddOnScreenDebugMessage(-1, 15.0f, FColor::Red,
                FString::Printf(TEXT("地图数据清单缺失：%s"), *ManifestPath));
        }
        return false;
    }

    TSharedPtr<FJsonObject> Manifest;
    const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ManifestText);
    if (!FJsonSerializer::Deserialize(Reader, Manifest) || !Manifest.IsValid())
    {
        UE_LOG(LogTemp, Error, TEXT("SG-City manifest is invalid: %s"), *ManifestPath);
        return false;
    }

    const TSharedPtr<FJsonObject>* Origin = nullptr;
    if (Manifest->TryGetObjectField(TEXT("origin"), Origin) && Origin && Origin->IsValid())
    {
        ACesiumGeoreference* Georeference = ACesiumGeoreference::GetDefaultGeoreference(this);
        Georeference->SetOriginLongitudeLatitudeHeight(FVector(
            (*Origin)->GetNumberField(TEXT("longitude")),
            (*Origin)->GetNumberField(TEXT("latitude")),
            (*Origin)->GetNumberField(TEXT("height"))));
    }

    const TArray<TSharedPtr<FJsonValue>>* ManifestLayers = nullptr;
    if (!Manifest->TryGetArrayField(TEXT("layers"), ManifestLayers) || !ManifestLayers)
    {
        UE_LOG(LogTemp, Error, TEXT("SG-City manifest contains no layers"));
        return false;
    }

    bool bAllLoaded = true;
    for (const TSharedPtr<FJsonValue>& LayerValue : *ManifestLayers)
    {
        const TSharedPtr<FJsonObject> Layer = LayerValue->AsObject();
        if (!Layer.IsValid())
        {
            bAllLoaded = false;
            continue;
        }

        const FString Id = Layer->GetStringField(TEXT("id"));
        const FString Entry = Layer->GetStringField(TEXT("entry"));
        const FString EntryPath = FPaths::Combine(ResolvedDataRoot, Entry);
        if (!FPaths::FileExists(EntryPath))
        {
            UE_LOG(LogTemp, Error, TEXT("SG-City layer entry missing: %s"), *EntryPath);
            bAllLoaded = false;
            continue;
        }

        ACesium3DTileset* Tileset = GetWorld()->SpawnActor<ACesium3DTileset>();
        if (!Tileset)
        {
            bAllLoaded = false;
            continue;
        }

        Tileset->SetTilesetSource(ETilesetSource::FromUrl);
        Tileset->SetUrl(SGCityData::ToFileUrl(EntryPath));
        Tileset->SetActorHiddenInGame(!Layer->GetBoolField(TEXT("visible")));
        Tileset->Tags.Add(FName(*FString::Printf(TEXT("SGCity.Layer.%s"), *Id)));
        LayerActors.Add(FName(*Id), Tileset);
    }

    return bAllLoaded && LayerActors.Num() > 0;
}

bool ASGCitySceneLoader::SetLayerVisible(FName LayerId, bool bVisible)
{
    const TObjectPtr<ACesium3DTileset>* Tileset = LayerActors.Find(LayerId);
    if (!Tileset || !Tileset->Get())
    {
        return false;
    }

    (*Tileset)->SetActorHiddenInGame(!bVisible);
    return true;
}
