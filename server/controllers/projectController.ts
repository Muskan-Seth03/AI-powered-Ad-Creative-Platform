import {Request, Response } from 'express'
import * as Sentry from "@sentry/node";
import { prisma } from '../configs/prisma.js';
import {v2 as cloudinary } from 'cloudinary'
import fs from 'fs';
import path from 'path';
import ai from '../configs/ai.js';
import axios from 'axios';


export const createProject = async (req:Request, res: Response) => {
    let tempProjectId: string;
    const { userId } = req.auth();
    let isCreditDeducted = false;

    const {name = 'New Project', aspectRatio, userPrompt, productName, productDescription, targetLength = 5} = req.body;

    const images: any = req.files;

    if(images.length < 2 || !productName){
        return res.status(400).json({message: 'Please upload at least 2 images'})
    }

    const user = await prisma.user.findUnique({
        where: {id: userId}
    })

    if(!user || user.credits < 5){
        return res.status(401).json({message: 'Insufficient credits'})
    }else{
        // deduct credits for image generation
        await prisma.user.update({
            where: {id: userId},
            data: {credits: {decrement: 5}}
        }).then(()=>{isCreditDeducted = true});
    }

    try {

        let uploadedImages = await Promise.all(
            images.map(async(item: any)=>{
                let result = await cloudinary.uploader.upload(item.path, {resource_type: 'image'});
                return result.secure_url
            })
        )

         const project = await prisma.project.create({
            data: {
                name,
                userId,
                productName,
                productDescription,
                userPrompt,
                aspectRatio,
                targetLength: parseInt(targetLength),
                uploadedImages,
                isGenerating: true
            }
         })

         tempProjectId = project.id;

         const prompt = `Combine the person and product into a realistic photo.
            Make the person naturally hold or use the product.
            Match lighting, shadows, scale and perspective.
            Make the person stand in professional studio lighting.
            Output ecommerce-quality photo realistic imagery.
            ${userPrompt}`;

         // Generate the image using DALL-E 3
         const dalleResponse = await ai.images.generate({
            model: "dall-e-3",
            prompt: prompt,
            n: 1,
            size: "1024x1024",
            quality: "hd",
            response_format: "b64_json"
         })

         if(!dalleResponse?.data?.[0]?.b64_json){
            throw new Error('Failed to generate image');
         }

         const finalBuffer = Buffer.from(dalleResponse.data[0].b64_json, 'base64')

         const base64Image = `data:image/png;base64,${finalBuffer.toString('base64')}`

         const uploadResult = await cloudinary.uploader.upload(base64Image, {resource_type: 'image'});

         await prisma.project.update({
            where: {id: project.id},
            data: {
                generatedImage: uploadResult.secure_url,
                isGenerating: false
            }
         })

         res.json({projectId: project.id})
        
    } catch (error:any) {
        if(tempProjectId!){
            // update project status and error message
            await prisma.project.update({
                where: {id: tempProjectId},
                data: {isGenerating: false, error: error.message}
            })
        }

        if(isCreditDeducted){
            // add credits back
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 5}}
            })
        }
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}


export const createVideo = async (req:Request, res: Response) => {
    const {userId} = req.auth()
    const { projectId } = req.body;
    let isCreditDeducted = false;

    const user = await prisma.user.findUnique({
        where: {id: userId}
    })

    if(!user || user.credits < 10){
        return res.status(401).json({ message: 'Insufficient credits' });
    }

    // deduct credits for video generation
    await prisma.user.update({
        where: {id: userId},
        data: {credits: {decrement: 10}}
    }).then(()=>{ isCreditDeducted = true} );

    try {
        const project = await prisma.project.findUnique({
            where: {id: projectId, userId},
            include: {user: true}
        })

        if(!project || project.isGenerating){
            return res.status(404).json({ message: 'Generation in progress' });
        }

        if(project.generatedVideo){
            return res.status(404).json({ message: 'Video already generated' });
        }

        await prisma.project.update({
            where: {id: projectId},
            data: {isGenerating: true}
        })

        const prompt = `make the person showcase the product which is ${project.productName} ${project.productDescription && `and Product Description: ${project.productDescription}`}`

        if(!project.generatedImage){
            throw new Error('Generated image not found');
        }

        // Note: OpenAI does not currently offer a video generation API
        // You have several options:
        // 1. Use OpenAI's DALL-E for additional frames and use a third-party video library
        // 2. Switch to another service like Runway ML, Synthesia, or similar
        // 3. Use Pika API, Kling AI, or other video generation services
        // For now, we'll throw an error indicating the need for alternative video generation service
        
        throw new Error('Video generation is not available with OpenAI. Consider using alternative services like Runway ML, Synthesia, or Pika API for video generation.');
        
    } catch (error:any) {

            // update project status and error message
            await prisma.project.update({
                where: {id: projectId, userId},
                data: {isGenerating: false, error: error.message}
            })

         if(isCreditDeducted){
            // add credits back
            await prisma.user.update({
                where: {id: userId},
                data: {credits: {increment: 10}}
            })
        }

        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}

export const getAllPublishedProjects = async (req:Request, res: Response) => {
    try {
        const projects = await prisma.project.findMany({
            where: {isPublished: true}
        })
        res.json({projects})

    } catch (error:any) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}

export const deleteProject = async (req:Request, res: Response) => {
    try {
        const { userId } = req.auth();
        const { projectId } = req.params;

        const project = await prisma.project.findUnique({
            where: {id: projectId, userId}
        })

         if (!project){
            return res.status(404).json({ message: 'Project not found' });
         }

         await prisma.project.delete({
            where: {id: projectId}
         })

         res.json({ message: 'Project deleted' });

    } catch (error:any) {
        Sentry.captureException(error);
        res.status(500).json({ message: error.message });
    }
}