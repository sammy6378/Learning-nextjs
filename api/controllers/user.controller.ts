import { NextFunction, Request, Response } from "express";
import { catchAsyncErrors } from "../middleware/catchAsyncErrors";
import ErrorHandler from "../utils/ErrorHandler";
import validator from 'validator';
import { IUser, userModel } from "../models/userModel";
import jwt, { JwtPayload } from "jsonwebtoken";
import { sendMail } from "../utils/mail";
import { accessTokenOptions, refreshTokenOptions, sendToken } from "../utils/jwt";
import { redis } from "../utils/redis";
import { createClient } from "@sanity/client";

const sanity = createClient({
    projectId: process.env.SANITY_PROJECT_ID,
    dataset: 'production',
    useCdn: false,
    apiVersion: '2023-01-01',
    token: process.env.SANITY_API_TOKEN,
});


  interface IRegisterUser {
    name: string;
    email: string;
    password: string;
}


// register
export const registerUser = catchAsyncErrors(async(req:Request, res: Response, next:NextFunction)=>{
    try {
        const { name, email, password } = req.body as IRegisterUser;

        if(!name || !email || !password){
            return next(new ErrorHandler('Please enter all fields', 400));
        }

        // validate email
        const isEmailValid = validator.isEmail(email);
        if(!isEmailValid){
            return next(new ErrorHandler('Invalid Email', 400));
        }

        // validate password
        const checkPassword = validator.isStrongPassword(password);
        if(!checkPassword){
            return next(new ErrorHandler('Password must be at least 8 characters long and contain at least 1 lowercase, 1 uppercase, 1 number and 1 special character', 400));
        }

        // check if email exists
        const emailExists = await userModel.findOne({email});
        if(emailExists){
            return next(new ErrorHandler('Email already exists', 400));
        }


        const user: IRegisterUser ={
            name,
            email,
            password
        }

        // create activation token
        const activationToken = createActivationToken(user);
        const activationCode = activationToken.activationCode;

        // send email
        const data = { user: { name: user.name}, activationCode};
        try {
            // send email
            await sendMail({
                template: 'activateEmail.ejs',
                email: user.email,
                subject: 'Account Activation',
                data
            });

            res.status(201).json({
                success: true,
                message: `Activation code sent to ${user.email}`,
                activationToken: activationToken.token,
            });
            
        } catch (error:any) {
            return next(new ErrorHandler(error.message, 500));  
        }
        
    } catch (error:any) {
        return next(new ErrorHandler(error.message, 500));
    }
})


// create activation token
interface IActivationToken {
    activationCode: string;
    token: string;
  }
const createActivationToken = (user: IRegisterUser): IActivationToken => {
    // activation code
    const activationCode = Math.floor(Math.random() * 9000 + 1000).toString(); // 4 digit code
    const token = jwt.sign(
        {user,activationCode},
         process.env.ACTIVATION_SECRET as string,
        {expiresIn: '5m'});

    return {activationCode, token};
}



// activate user
export const activateUser = catchAsyncErrors(async(req: Request, res: Response, next:NextFunction)=>{
    try {
        const { activation_token, activation_code } = req.body;

        const verifyToken = jwt.verify(activation_token, process.env.ACTIVATION_SECRET as string) as {user: IUser; activationCode: string};
        if(activation_code !== verifyToken.activationCode){
            return next(new ErrorHandler('Invalid Activation Code', 400));
        }

        const newUser = verifyToken.user;
        const user = await userModel.create({
            name: newUser.name,
            email: newUser.email,
            password: newUser.password
        })

        res.status(201).json({
            success: true,
            user,
            message: 'Account activated successfully',
        });
    } catch (error:any) {
        return next(new ErrorHandler(error.message, 500));  
    }
});


// login user
export const userLogin = catchAsyncErrors(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { password, email } = req.body;
        if (!password || !email) {
          return next(new ErrorHandler("Please provide all the fields", 400));
        }
  
        const user = await userModel.findOne({ email });
        if (!user) {
          return next(new ErrorHandler("email or password is invalid", 400));
        }
  
        const passwordCorrect = await user.comparePasswords(password);
        if (!passwordCorrect) {
          return next(new ErrorHandler("email or password is invalid", 400));
        }
  
        //create cookies
        try {
          await sendToken(user, res);
        } catch (error: any) {
          return next(new ErrorHandler(error.message, 400));
        }
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    }
  );
  


//logout user
export const logoutUser = catchAsyncErrors(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.cookie("access_token", "", { maxAge: 1 });
        res.cookie("refresh_token", "", { maxAge: 1 });
  
        const redisUser = req.user?._id as string;
        if (redisUser) {
          console.log("User session deleted from redis");
          await redis.del(redisUser);
        } else {
          console.log(`user: ${redisUser} not found in redis`);
        }
  
        res.status(200).json({ success: true, message: "User logged out" });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    }
  );


  //update access-token
export const UpdateAccessToken = catchAsyncErrors(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const refresh_token = req.cookies.refresh_token;
        if (!refresh_token) {
          return next(new ErrorHandler("Refresh token not found", 401));
        }
  
        const decoded = jwt.verify(
          refresh_token,
          process.env.REFRESH_TOKEN as string
        ) as JwtPayload;
        if (!decoded) {
          return next(new ErrorHandler("Refresh token not found", 401));
        }
  
        //const user = userModel.findById(decoded.id);
        const session = (await redis.get(decoded.id)) as string;
        const user = JSON.parse(session);
        req.user = user;
  
        const accessToken = jwt.sign(
          { id: user._id },
          process.env.ACCESS_TOKEN as string,
          { expiresIn: "5m" }
        );
        const refreshToken = jwt.sign(
          { id: user._id },
          process.env.REFRESH_TOKEN as string,
          { expiresIn: "7d" }
        );
  
        //create new cookies
        res.cookie("access_token", accessToken, accessTokenOptions);
        res.cookie("refresh_token", refreshToken, refreshTokenOptions);
  
        res.status(200).json({ success: true, accessToken });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    }
  );


  //get user info
export const getUserInfo = catchAsyncErrors(
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = req.user?._id as string;
        // const user = await userModel.findById(userId).select("-password");
        const redisUser = (await redis.get(userId)) as string;
        const user = await JSON.parse(redisUser);
        if (!user) {
          return next(new ErrorHandler(`user: ${userId} not found`, 404));
        }
  
        res.status(200).json({ success: true, user });
      } catch (error: any) {
        return next(new ErrorHandler(error.message, 400));
      }
    }
  );


  export const setReminder = catchAsyncErrors(async (req: Request, res: Response, next: NextFunction) => {
    try {
        const query = `*[_type == "reminder" && sent == false && reminderTime <= now()]`;
        const reminders = await sanity.fetch(query);

        if (reminders.length === 0) {
            return res.status(200).json({ success: true, message: 'No reminders to send' });
        }

        for (const reminder of reminders) {
            if (!reminder.eventId || !reminder.eventId._ref) {
                console.log(`Invalid event reference in reminder ID: ${reminder._id}`);
                continue;
            }

            // Extract actual event ID
            const eventId = reminder.eventId._ref;

            // Fetch event details
            const eventQuery = `*[_type == "event" && _id == $eventId][0]`;
            const event = await sanity.fetch(eventQuery, { eventId });

            if (!event) {
                console.log(`Event not found for reminder ID: ${reminder._id}`);
                continue;
            }

            // Check if user exists in MongoDB
            const user = await userModel.findById(reminder.userId);
            if (!user) {
                console.log(`User not found with ID: ${reminder.userId}`);
                continue;
            }

            // Data to pass to the email template
            const data = {
                user: { name: user.name },
                event,
                eventLink: `${process.env.FRONTEND_URL}events/${event._id}`,
            };

            try {
                // Send email using EJS template
                await sendMail({
                    template: 'reminderEvent.ejs',
                    email: user.email,
                    subject: `Reminder: ${event.title}`,
                    data,
                });

                // Mark reminder as sent in Sanity
                await sanity.patch(reminder._id).set({ sent: true }).commit();
            } catch (error: any) {
                console.error(`Failed to send email to ${user.email}: ${error.message}`);
            }
        }

        res.status(200).json({ success: true, message: 'Reminders processed successfully' });
    } catch (error: any) {
        return next(new ErrorHandler(error.message, 500));
    }
});
