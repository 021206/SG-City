#include "SGCityData.h"

#include "HAL/PlatformProcess.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "GenericPlatform/GenericPlatformMisc.h"

namespace
{
    bool IsValidDataRoot(const FString& Candidate)
    {
        return !Candidate.IsEmpty() &&
            FPaths::FileExists(FPaths::Combine(Candidate, TEXT("manifest.json")));
    }

    FString NormalizeRoot(const FString& Candidate)
    {
        if (FPaths::IsRelative(Candidate))
        {
            return FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectDir(), Candidate));
        }
        return FPaths::ConvertRelativePathToFull(Candidate);
    }

    void AddParentCandidates(const FString& Start, TArray<FString>& OutCandidates)
    {
        FString Current = FPaths::ConvertRelativePathToFull(Start);
        for (int32 Depth = 0; Depth < 7 && !Current.IsEmpty(); ++Depth)
        {
            OutCandidates.Add(FPaths::Combine(Current, TEXT("SGCityData")));
            OutCandidates.Add(FPaths::Combine(Current, TEXT("LocalData/SGCityData")));
            const FString Parent = FPaths::GetPath(Current);
            if (Parent == Current)
            {
                break;
            }
            Current = Parent;
        }
    }
}

FString SGCityData::GetManifestPath(const FString& DataRoot)
{
    return FPaths::Combine(DataRoot, TEXT("manifest.json"));
}

FString SGCityData::FindDataRoot()
{
    FString Candidate;
    if (FParse::Value(FCommandLine::Get(), TEXT("-SGCityData="), Candidate) && IsValidDataRoot(Candidate))
    {
        return NormalizeRoot(Candidate);
    }

    Candidate = FPlatformMisc::GetEnvironmentVariable(TEXT("SGCITY_DATA_DIR"));
    if (IsValidDataRoot(Candidate))
    {
        return NormalizeRoot(Candidate);
    }

    if (GConfig->GetString(
            TEXT("/Script/SGCity.SGCityRuntimeSettings"),
            TEXT("DataRoot"),
            Candidate,
            GGameIni) && IsValidDataRoot(Candidate))
    {
        return NormalizeRoot(Candidate);
    }

    TArray<FString> Candidates;
    AddParentCandidates(FPaths::ProjectDir(), Candidates);
    AddParentCandidates(FPaths::GetPath(FPlatformProcess::ExecutablePath()), Candidates);

    for (const FString& Root : Candidates)
    {
        if (IsValidDataRoot(Root))
        {
            return NormalizeRoot(Root);
        }
    }

    return NormalizeRoot(FPaths::Combine(FPaths::ProjectDir(), TEXT("LocalData/SGCityData")));
}

FString SGCityData::ToFileUrl(const FString& AbsolutePath)
{
    FString Normalized = FPaths::ConvertRelativePathToFull(AbsolutePath);
    Normalized.ReplaceInline(TEXT("\\"), TEXT("/"));

    const FTCHARToUTF8 Utf8(*Normalized);
    FString Encoded;
    Encoded.Reserve(Normalized.Len() * 2);

    static const TCHAR Hex[] = TEXT("0123456789ABCDEF");
    for (int32 Index = 0; Index < Utf8.Length(); ++Index)
    {
        const uint8 Value = static_cast<uint8>(Utf8.Get()[Index]);
        const bool bUnreserved =
            (Value >= 'a' && Value <= 'z') ||
            (Value >= 'A' && Value <= 'Z') ||
            (Value >= '0' && Value <= '9') ||
            Value == '-' || Value == '.' || Value == '_' || Value == '~' ||
            Value == '/' || Value == ':';

        if (bUnreserved)
        {
            Encoded.AppendChar(static_cast<TCHAR>(Value));
        }
        else
        {
            Encoded.AppendChar('%');
            Encoded.AppendChar(Hex[(Value >> 4) & 0xF]);
            Encoded.AppendChar(Hex[Value & 0xF]);
        }
    }

    return Normalized.StartsWith(TEXT("/"))
        ? FString::Printf(TEXT("file://%s"), *Encoded)
        : FString::Printf(TEXT("file:///%s"), *Encoded);
}
